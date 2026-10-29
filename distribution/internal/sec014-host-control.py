"""SEC014 host lock/journal component. No Docker, installer or CLI entry yet."""

from contextlib import contextmanager
import errno
import fcntl
import hashlib
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


def _saved(parent, name, owner, normal_group=None, *, facts=None):
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
        result=json.loads(raw)
    except ValueError:
        raise ControlError('SEC014_CONTROL_JOURNAL_INVALID') from None
    if facts is not None:
        facts.update(sha256=hashlib.sha256(raw).hexdigest(),metadata=tuple(getattr(before,key) for key in keys))
    return result


def _normal(path, *, role='bellteam', models=None):
    path = Path(path)
    names = {'bellteam': ('normal.json', 'previous-normal.json'),
             'state-prepare': ('compose.state-prepare.yaml',),
             'state-maintenance': ('compose.state-maintenance.json',)}
    if (not path.is_absolute() or path.resolve(strict=True) != path
            or path.name not in names.get(role, ())
            or not re.fullmatch(r'\.bellteam-compose\.[a-zA-Z0-9]{6}', path.parent.name)):
        raise ControlError('SEC014_CONTROL_GENERATION')
    parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        directory = os.fstat(parent)
        owner = directory.st_uid, directory.st_gid
        _private(directory, owner, True)
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
        with os.fdopen(fd, 'rb') as stream:
            before = os.fstat(stream.fileno())
            _private(before, owner)
            raw = stream.read(1048577)
            after = os.fstat(stream.fileno())
        linked = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
        keys = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink',
                'st_size', 'st_mtime_ns', 'st_ctime_ns')
        if (len(raw) > 1048576 or len(raw) != before.st_size
                or any(tuple(getattr(value, key) for key in keys)
                       != tuple(getattr(before, key) for key in keys) for value in (after, linked))
                or _identity(os.lstat(path.parent)) != _identity(directory)):
            raise ControlError('SEC014_CONTROL_GENERATION')
        try:
            model = json.loads(raw)
            service = model['services'][role]
            image_ref = model.get('x-bellteam-image-ref')
            if image_ref is not None and (type(image_ref) is not str or not re.fullmatch(
                    r'ghcr\.io/kitepon/bellteam-server@sha256:[a-f0-9]{64}', image_ref)):
                raise ValueError()
            if role != 'bellteam':
                if ((role == 'state-prepare' and (
                            model.get('name') != 'bellteam-state-prepare'
                            or not set(model) <= {'name','services','x-bellteam-image-ref'}))
                        or set(model['services']) != {role}
                        or type(service['image']) is not str
                        or not re.fullmatch('sha256:[a-f0-9]{64}', service['image'])):
                    raise ValueError()
                if models is not None:
                    models[role] = model
                return {'path': str(path), 'sha256': hashlib.sha256(raw).hexdigest(),
                        'device': before.st_dev, 'inode': before.st_ino,
                        'parentDevice': directory.st_dev, 'parentInode': directory.st_ino,
                        'owner': list(owner), 'image': service['image'], 'service': service,
                        **({'imageRef': image_ref} if image_ref is not None else {})}
            token = service.get('environment', {}).get('BELLTEAM_NORMAL_ADMISSION_TOKEN')
            mounts = [v for v in service.get('volumes', [])
                      if v.get('target') == '/run/bellteam-maintenance']
            if (type(service['image']) is not str
                    or not re.fullmatch('sha256:[a-f0-9]{64}', service['image'])
                    or type(token) is not str or not re.fullmatch('[a-f0-9]{64}', token)
                    or len(mounts) != 1 or mounts[0].get('type') != 'bind'
                    or mounts[0].get('source') != str(CONTROL)
                    or mounts[0].get('read_only') is not True
                    or mounts[0].get('bind', {}).get('create_host_path') is not False):
                raise ValueError()
            for volume in service.get('volumes', []):
                if volume.get('type') != 'bind': continue
                source = Path(volume['source'])
                if not source.is_absolute() or path.parent.is_relative_to(source.resolve()):
                    raise ValueError()
        except (ValueError, KeyError, TypeError, AttributeError):
            raise ControlError('SEC014_CONTROL_GENERATION') from None
        result = {'path': str(path), 'sha256': hashlib.sha256(raw).hexdigest(),
                'device': before.st_dev, 'inode': before.st_ino,
                'parentDevice': directory.st_dev, 'parentInode': directory.st_ino,
                'owner': list(owner), 'image': service['image'], 'token': token}
        if image_ref is not None:
            result['imageRef'] = image_ref
        if path.name == 'normal.json':
            for kind, filename in (('prepare', 'compose.state-prepare.yaml'),
                                   ('maintenance', 'compose.state-maintenance.json')):
                sibling = path.parent / filename
                if not os.path.lexists(sibling):
                    continue
                result[kind] = _normal(sibling, role='state-' + kind, models=models)
                if (result[kind]['image'] != result['image']
                        or ((kind == 'prepare' or 'imageRef' in result[kind])
                            and result[kind].get('imageRef') != result.get('imageRef'))):
                    raise ControlError('SEC014_CONTROL_GENERATION')
        if models is not None:
            models[role] = model
        return result
    finally:
        os.close(parent)


def _selector(lock, direction):
    raw = (direction + '\n').encode('ascii')
    os.ftruncate(lock, 0)
    os.lseek(lock, 0, os.SEEK_SET)
    if os.write(lock, raw) != len(raw):
        raise ControlError('SEC014_CONTROL_DIRECTION_WRITE')
    os.fsync(lock)


def _archive(tx, prior, normal):
    history = []
    for direction, item in prior.items():
        previous = item.get('normal')
        if (previous is None or _normal(previous['path']) != previous
                or Path(previous['path']).parent == Path(normal['path']).parent):
            raise ControlError('SEC014_CONTROL_GENERATION')
        destination = Path(previous['path']).parent / 'sec014-control-history'
        if os.path.lexists(destination):
            raise ControlError('SEC014_CONTROL_GENERATION')
        names = ['transaction-' + direction + '.json']
        for phase in PHASES:
            name = direction + '-' + phase + '.receipt.json'
            receipt = _saved(tx.parent, name, tx.owner)
            if (receipt is _ABSENT or type(receipt) is not dict
                    or receipt.get('direction') != direction or receipt.get('phase') != phase
                    or receipt.get('status') != 'verified'
                    or receipt.get('actorPid') != item['actorPid']
                    or receipt.get('actorStartTicks') != item['actorStartTicks']):
                raise ControlError('SEC014_CONTROL_UNRESOLVED')
            names.append(name)
        evidence = direction + '-prepare-evidence.json'
        if _saved(tx.parent, evidence, tx.owner) is not _ABSENT:
            names.append(evidence)
        if any(destination == value[0] for value in history):
            raise ControlError('SEC014_CONTROL_GENERATION')
        history.append((destination, names, previous))
    if not history: return
    # A crash during the moves leaves this durable selector invalid for every new actor/normal.
    _selector(tx.lock, 'archiving')
    for destination, names, previous in history:
        tx.check()
        parent = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            expected = previous['parentDevice'], previous['parentInode']
            if (_identity(os.fstat(parent)) != expected
                    or _normal(previous['path']) != previous):
                raise ControlError('SEC014_CONTROL_GENERATION')
            os.mkdir(destination.name, mode=0o700, dir_fd=parent)
            archive = os.open(destination.name, os.O_RDONLY | os.O_DIRECTORY
                              | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
            try:
                _private(os.fstat(archive), tx.owner, True)
                os.fsync(parent)
                for name in names:
                    tx.check()
                    if (_normal(previous['path']) != previous
                            or _identity(os.stat(destination.name, dir_fd=parent,
                                                 follow_symlinks=False)) != _identity(os.fstat(archive))):
                        raise ControlError('SEC014_CONTROL_GENERATION')
                    os.rename(name, name, src_dir_fd=tx.parent, dst_dir_fd=archive)
                    os.fsync(archive)
                    os.fsync(tx.parent)
                if (_normal(previous['path']) != previous
                        or _identity(os.stat(destination.name, dir_fd=parent,
                                             follow_symlinks=False)) != _identity(os.fstat(archive))):
                    raise ControlError('SEC014_CONTROL_GENERATION')
            finally:
                os.close(archive)
        finally:
            os.close(parent)


class _Transaction:
    _docker_socket_path = Path('/var/run/docker.sock')

    def __init__(self, path, parent, lock, owner, direction, normal_group=None, normal=None):
        self.path, self.parent, self.lock, self.owner = path, parent, lock, owner
        self.normal_group, self.shared = normal_group, False
        self.parent_identity = _identity(os.fstat(parent))
        self.lock_identity = _identity(os.fstat(lock))
        self._docker_socket_original = None
        self._writer_image_original = None
        self.name = 'transaction-' + direction + '.json'
        self.value = {'schema': SCHEMA, 'direction': direction, 'status': 'incomplete',
                      'actorPid': os.getpid(), 'actorStartTicks': int(
                          Path('/proc/self/stat').read_text().rsplit(') ', 1)[1]
                          .split()[19]), 'phases': []}
        if normal_group is not None:
            self.value['admission'] = None
        if normal is not None:
            self.value['normal'] = normal

    def check(self, *, models=None):
        if (os.getpid() != self.value['actorPid'] or int(
                Path('/proc/self/stat').read_text().rsplit(') ', 1)[1].split()[19]) != self.value['actorStartTicks']):
            raise ControlError('SEC014_CONTROL_ACTOR_IDENTITY')
        if 'normal' in self.value and _normal(self.value['normal']['path'], models=models) != self.value['normal']:
            raise ControlError('SEC014_CONTROL_GENERATION')
        parent = os.lstat(self.path)
        linked = os.stat('sec014.lock', dir_fd=self.parent, follow_symlinks=False)
        held = os.fstat(self.lock)
        for value, directory in ((parent, True), (linked, False), (held, False)):
            _private(value, self.owner, directory, self.normal_group)
        if (_identity(parent) != self.parent_identity
                or _identity(linked) != self.lock_identity
                or _identity(held) != self.lock_identity):
            raise ControlError('SEC014_CONTROL_IDENTITY_CHANGED')
        if self._docker_socket_original is not None:
            self._socket_observation()
        if self._writer_image_original is not None:
            facts={}
            saved=_saved(self.parent,self.value['direction']+'-writer-image.output.json',self.owner,facts=facts)
            if saved!=self._writer_image_original['output'] or facts!=self._writer_image_original['file']:
                raise ControlError('SEC014_CONTROL_WRITER_IMAGE_CHANGED')

    def _socket_observation(self):
        # shortcut: pathname metadata only, require host peer/ACL authority before live connection.
        path=self._docker_socket_path
        fd=os.open(path,os.O_PATH|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:
            info=os.fstat(fd)
            keys=('st_dev','st_ino','st_uid','st_gid','st_mode','st_nlink','st_ctime_ns')
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid!=self.owner[0]:
                raise ControlError('SEC014_CONTROL_DOCKER_SOCKET')
            acl,acl_errno=None,None
            try:acl=os.getxattr(path,'system.posix_acl_access',follow_symlinks=False)
            except OSError as error:
                if error.errno!=errno.ENODATA:raise
                acl_errno=error.errno
            # shortcut: ACL over 4096B is refused, review saved-record cap before increasing.
            if acl is not None and len(acl)>4096:
                raise ControlError('SEC014_CONTROL_DOCKER_SOCKET_ACL_LIMIT')
            linked=os.stat(path,follow_symlinks=False)
            if any(getattr(info,key)!=getattr(linked,key) for key in keys):
                raise ControlError('SEC014_CONTROL_DOCKER_SOCKET')
            namespace=os.stat('/proc/thread-self/ns/mnt')
            value=dict(path=str(path),dockerHost='unix://'+str(path),device=str(info.st_dev),
                inode=str(info.st_ino),uid=info.st_uid,gid=info.st_gid,
                mode=format(stat.S_IMODE(info.st_mode),'04o'),links=info.st_nlink,
                ctimeNs=str(info.st_ctime_ns),namespaceDevice=str(namespace.st_dev),
                namespaceInode=str(namespace.st_ino),accessAcl=dict(
                    rawHex=None if acl is None else acl.hex(),errno=acl_errno),hostAuthority=False)
            if self._docker_socket_original is not None and value!=self._docker_socket_original:
                raise ControlError('SEC014_CONTROL_DOCKER_SOCKET_CHANGED')
            return value
        finally:os.close(fd)

    def _docker_endpoint(self):
        self.check()
        value=self._socket_observation()
        if self._docker_socket_original is None:self._docker_socket_original=dict(value)
        self.check()
        return value

    def _writer_config(self):
        models = {}
        self.check(models=models)
        try:
            services = {}
            for role in ('bellteam', 'state-maintenance'):
                volumes = models[role]['services'][role]['volumes']
                if type(volumes) is not list or any(type(v) is not dict for v in volumes):
                    raise ValueError()
                projected = [{key: v[key] for key in ('type', 'source', 'target', 'read_only') if key in v}
                             for v in volumes]
                if any(type(value) is not (bool if key == 'read_only' else str)
                       for mount in projected for key, value in mount.items()):
                    raise ValueError()
                services[role] = {'image': models[role]['services'][role]['image'], 'volumes': projected}
            names = {mount['source'] for mount in services['bellteam']['volumes']
                     if mount.get('type') == 'volume'}
            volumes = {name: {'name': models['bellteam']['volumes'][name]['name']} for name in names}
            if any(type(volume['name']) is not str for volume in volumes.values()):
                raise ValueError()
        except (ValueError, KeyError, TypeError, AttributeError):
            raise ControlError('SEC014_CONTROL_WRITER_INPUT') from None
        self.check()
        return {'services': services, 'volumes': volumes}

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
        if ('normal' in self.value and (image != self.value['normal']['image']
                or token != self.value['normal']['token'])):
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
def _hold(path, direction, owner, normal_group=None, saved_normal=None):
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
        normal = _normal(saved_normal) if saved_normal is not None else None
        if normal is not None and (normal_group is None or os.path.lexists(
                Path(normal['path']).parent / 'sec014-control-history')):
            raise ControlError('SEC014_CONTROL_GENERATION')
        transaction = _Transaction(Path(path), parent, lock, owner, direction, normal_group, normal)
        transaction.check()
        selector = os.pread(lock, 32, 0)
        if selector not in (b'', b'to-server\n', b'to-legacy\n'):
            raise ControlError('SEC014_CONTROL_UNRESOLVED')
        previous = {}
        for prior in DIRECTIONS:
            item = _saved(parent, 'transaction-' + prior + '.json', owner, normal_group)
            if item is _ABSENT:
                continue
            keys = {'schema', 'direction', 'status', 'actorPid', 'actorStartTicks', 'phases'}
            if normal_group is not None:
                keys.add('admission')
            if type(item) is dict and 'normal' in item:
                keys.add('normal')
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
            previous[prior] = item
            if direction == prior and normal is None:
                raise ControlError('SEC014_CONTROL_ALREADY_RECORDED')
        if selector and selector.decode('ascii').strip() not in previous:
            raise ControlError('SEC014_CONTROL_UNRESOLVED')
        if normal is not None:
            _archive(transaction, previous, normal)
        fd = os.open(transaction.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                     | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
        os.close(fd)
        transaction._save()
        if normal_group is not None:
            _selector(lock, direction)
        yield transaction
        # A normal Python return does not prove completion of daemon work.
    finally:
        if lock is not None:
            os.close(lock)
        os.close(parent)


@contextmanager
def host_control(direction, *, saved_normal):
    if any(value != 0 for value in
           (os.getuid(), os.geteuid(), os.getgid(), os.getegid())):
        raise ControlError('SEC014_CONTROL_ROOT_REQUIRED')
    with _hold(CONTROL, direction, (0, 0), normal_group=1001,
               saved_normal=saved_normal) as transaction:
        yield transaction
