"""SEC014 host lock/journal component. No Docker, installer or CLI entry yet."""

from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import tempfile


CONTROL = Path('/home/kite/BellTeam/runtime/server-only/maintenance-control')
PHASES = ('writers_stopped', 'prepared', 'migrated', 'binds_confirmed',
          'started', 'verified')
DIRECTIONS = ('to-server', 'to-legacy')
SCHEMA = 'bellteam.sec014.host-transaction.v1'
_ABSENT = object()


class ControlError(RuntimeError):
    pass


def _identity(value):
    return value.st_dev, value.st_ino


def _private(value, owner, directory=False, normal_group=None):
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    expected_owner = owner if normal_group is None else (owner[0], normal_group)
    mode = (0o700 if directory else 0o600) if normal_group is None else (0o750 if directory else 0o640)
    if (not kind(value.st_mode) or (value.st_uid, value.st_gid) != expected_owner
            or stat.S_IMODE(value.st_mode) != mode
            or (not directory and value.st_nlink != 1)):
        raise ControlError('SEC014_CONTROL_METADATA')


def _saved(parent, name, owner, normal_group=None):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    except FileNotFoundError:
        return _ABSENT
    try:
        with os.fdopen(fd, 'rb') as stream:
            before = os.fstat(stream.fileno())
            _private(before, owner, normal_group=normal_group)
            raw = stream.read(65537)
            after = os.fstat(stream.fileno())
            linked = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        raise ControlError('SEC014_CONTROL_JOURNAL_CHANGED') from None
    keys = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink',
            'st_size', 'st_mtime_ns', 'st_ctime_ns')
    if (len(raw) > 65536 or len(raw) != before.st_size
            or any(tuple(getattr(value, key) for key in keys)
                   != tuple(getattr(before, key) for key in keys)
                   for value in (after, linked))):
        raise ControlError('SEC014_CONTROL_JOURNAL_CHANGED')
    try:
        return json.loads(raw)
    except ValueError:
        raise ControlError('SEC014_CONTROL_JOURNAL_INVALID') from None


class _Transaction:
    def __init__(self, path, parent, lock, owner, direction, normal_group=None):
        self.path, self.parent, self.lock, self.owner = path, parent, lock, owner
        self.normal_group, self.shared = normal_group, False
        self.parent_identity = _identity(os.fstat(parent))
        self.lock_identity = _identity(os.fstat(lock))
        self.name = 'transaction-' + direction + '.json'
        self.value = {'schema': SCHEMA, 'direction': direction, 'status': 'incomplete',
                      'actorPid': os.getpid(), 'actorStartTicks': int(
                          Path('/proc/self/stat').read_text().rsplit(') ', 1)[1]
                          .split()[19]), 'phases': []}
        if normal_group is not None:
            self.value['admission'] = None

    def check(self):
        parent = os.lstat(self.path)
        linked = os.stat('sec014.lock', dir_fd=self.parent, follow_symlinks=False)
        held = os.fstat(self.lock)
        for value, directory in ((parent, True), (linked, False), (held, False)):
            _private(value, self.owner, directory, self.normal_group)
        if (_identity(parent) != self.parent_identity
                or _identity(linked) != self.lock_identity
                or _identity(held) != self.lock_identity):
            raise ControlError('SEC014_CONTROL_IDENTITY_CHANGED')

    def _save(self):
        self.check()
        fd, temporary = tempfile.mkstemp(prefix='.sec014-', dir=self.path)
        try:
            with os.fdopen(fd, 'w') as stream:
                if self.normal_group is not None:
                    os.fchown(stream.fileno(), -1, self.normal_group)
                    os.fchmod(stream.fileno(), 0o640)
                json.dump(self.value, stream, sort_keys=True, allow_nan=False)
                stream.flush()
                os.fsync(stream.fileno())
            self.check()
            os.replace(temporary, self.name, dst_dir_fd=self.parent)
            os.fsync(self.parent)
        finally:
            Path(temporary).unlink(missing_ok=True)

    def admit_normal(self, container_id, image, token):
        if (self.normal_group is None or self.value['phases'] != list(PHASES[:4])
                or self.value['admission'] is not None):
            raise ControlError('SEC014_CONTROL_HANDOFF_PHASE')
        if (type(container_id) is not str or not re.fullmatch('[a-f0-9]{64}', container_id)
                or type(image) is not str or not re.fullmatch('sha256:[a-f0-9]{64}', image)
                or type(token) is not str or not re.fullmatch('[a-f0-9]{64}', token)):
            raise ControlError('SEC014_CONTROL_HANDOFF_SELECTION')
        self.value['admission'] = {'containerId': container_id, 'image': image, 'token': token}
        self._save()
        # Conversion can release EX briefly; the durable incomplete journal bars another actor.
        fcntl.flock(self.lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
        self.shared = True
        self.check()

    def confirmed(self, phase):
        # The fixed caller must supply a positive phase receipt before this call.
        if (len(self.value['phases']) >= len(PHASES)
                or phase != PHASES[len(self.value['phases'])]):
            raise ControlError('SEC014_CONTROL_PHASE_ORDER')
        if self.normal_group is not None and phase in PHASES[4:] and not self.shared:
            raise ControlError('SEC014_CONTROL_HANDOFF_REQUIRED')
        self.value['phases'].append(phase)
        if tuple(self.value['phases']) == PHASES:
            self.value['status'] = 'completed'
        self._save()


@contextmanager
def _hold(path, direction, owner, normal_group=None):
    """Private path/identity injection is for ordinary filesystem tests only."""
    if direction not in DIRECTIONS:
        raise ControlError('SEC014_CONTROL_DIRECTION')
    parent = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    lock = None
    try:
        _private(os.fstat(parent), owner, True, normal_group)
        try:
            lock = os.open('sec014.lock', os.O_RDWR | os.O_CREAT | os.O_EXCL
                           | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
        except FileExistsError:
            lock = os.open('sec014.lock', os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
        else:
            if normal_group is not None:
                os.fchown(lock, -1, normal_group)
                os.fchmod(lock, 0o640)
        _private(os.fstat(lock), owner, normal_group=normal_group)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ControlError('SEC014_CONTROL_BUSY') from None
        transaction = _Transaction(Path(path), parent, lock, owner, direction, normal_group)
        transaction.check()
        for prior in DIRECTIONS:
            item = _saved(parent, 'transaction-' + prior + '.json', owner, normal_group)
            if item is _ABSENT:
                continue
            keys = {'schema', 'direction', 'status', 'actorPid', 'actorStartTicks', 'phases'}
            if normal_group is not None:
                keys.add('admission')
            if (type(item) is not dict or set(item) != keys
                    or item['schema'] != SCHEMA
                    or type(item['actorPid']) is not int or item['actorPid'] <= 0
                    or type(item['actorStartTicks']) is not int
                    or item['actorStartTicks'] <= 0
                    or item.get('direction') != prior
                    or item.get('status') != 'completed'
                    or item.get('phases') != list(PHASES)):
                raise ControlError('SEC014_CONTROL_UNRESOLVED')
            if normal_group is not None:
                selected = item['admission']
                if (type(selected) is not dict or set(selected) != {'containerId', 'image', 'token'}
                        or any(type(selected[key]) is not str or not re.fullmatch(pattern, selected[key])
                               for key, pattern in [('containerId', '[a-f0-9]{64}'),
                                                    ('image', 'sha256:[a-f0-9]{64}'),
                                                    ('token', '[a-f0-9]{64}')])):
                    raise ControlError('SEC014_CONTROL_UNRESOLVED')
            if direction == prior:
                raise ControlError('SEC014_CONTROL_ALREADY_RECORDED')
        fd = os.open(transaction.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                     | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
        os.close(fd)
        transaction._save()
        if normal_group is not None:
            raw = (direction + '\n').encode('ascii')
            os.ftruncate(lock, 0)
            os.lseek(lock, 0, os.SEEK_SET)
            if os.write(lock, raw) != len(raw):
                raise ControlError('SEC014_CONTROL_DIRECTION_WRITE')
            os.fsync(lock)
        yield transaction
        # A normal Python return does not prove completion of daemon work.
    finally:
        if lock is not None:
            os.close(lock)
        os.close(parent)


@contextmanager
def host_control(direction):
    if any(value != 0 for value in
           (os.getuid(), os.geteuid(), os.getgid(), os.getegid())):
        raise ControlError('SEC014_CONTROL_ROOT_REQUIRED')
    with _hold(CONTROL, direction, (0, 0), normal_group=1001) as transaction:
        yield transaction
