"""SEC014 host lock/journal and kernel peer observation. No installer/CLI entry."""

from contextlib import contextmanager
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import socket
import struct
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


def _saved(parent, name, owner, normal_group=None, *, facts=None, limit=65536):
    if type(limit) is not int or not 1 <= limit <= 4194304:
        raise ControlError('SEC014_CONTROL_SAVE_LIMIT')
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    except FileNotFoundError:
        return _ABSENT
    try:
        with os.fdopen(fd, 'rb') as stream:
            before = os.fstat(stream.fileno())
            _private(before, owner, normal_group=normal_group)
            raw = stream.read(limit+1)
            after = os.fstat(stream.fileno())
            linked = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        raise ControlError('SEC014_CONTROL_JOURNAL_CHANGED') from None
    keys = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink',
            'st_size', 'st_mtime_ns', 'st_ctime_ns')
    if (len(raw) > limit or len(raw) != before.st_size
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


@contextmanager
def _generation_file(path, names):
    path = Path(path)
    if (not path.is_absolute() or path.resolve(strict=True) != path
            or path.name not in names
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
        except (ValueError, TypeError):
            raise ControlError('SEC014_CONTROL_GENERATION') from None
        yield model, {'path': str(path), 'sha256': hashlib.sha256(raw).hexdigest(),
                      'device': before.st_dev, 'inode': before.st_ino,
                      'parentDevice': directory.st_dev, 'parentInode': directory.st_ino,
                      'owner': list(owner)}
    finally:
        os.close(parent)


def _normal(path, *, role='bellteam', models=None):
    path = Path(path)
    names = {'bellteam': ('normal.json', 'previous-normal.json'),
             'state-prepare': ('compose.state-prepare.yaml',),
             'state-maintenance': ('compose.state-maintenance.json',)}
    with _generation_file(path, names.get(role, ())) as (model, reference):
        try:
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
                return dict(reference, image=service['image'], service=service,
                            **({'imageRef': image_ref} if image_ref is not None else {}))
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
        result = dict(reference, image=service['image'], token=token)
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
        # Preserve every private native original/config alongside its generation.
        for name in sorted(os.listdir(tx.parent)):
            if name in names or not name.startswith(direction+'-'):
                continue
            if not re.fullmatch('[a-z0-9.-]{1,255}', name):
                raise ControlError('SEC014_CONTROL_UNRESOLVED')
            info = os.stat(name, dir_fd=tx.parent, follow_symlinks=False)
            _private(info, tx.owner, stat.S_ISDIR(info.st_mode))
            names.append(name)
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


def _archive_recovery(tx, recovery, normal):
    """A completed explicit recovery settles, but never rewrites, the old attempt."""
    failed = lambda: ControlError('SEC014_CONTROL_RECOVERY_UNRESOLVED')
    keys={'schema','direction','status','actorPid','actorStartTicks','phases','admission','normal',
          'layout','controlled','previousNormal','priorSettlement','selection','receipts','priorJournal'}
    if (normal is None or type(recovery) is not dict or set(recovery)!=keys
            or recovery['schema']!='bellteam.sec014.host-recovery.v1' or recovery['direction']!='to-legacy'
            or recovery['status']!='completed' or recovery['phases']!=list(PHASES)
            or recovery['layout'] not in ('legacy','server') or type(recovery['controlled']) is not bool
            or any(type(recovery[key]) is not int or recovery[key]<=0 for key in ('actorPid','actorStartTicks'))
            or type(recovery['normal']) is not dict or _normal(recovery['normal']['path'])!=recovery['normal']
            or Path(recovery['normal']['path']).parent==Path(normal['path']).parent
            or type(recovery['receipts']) is not list or len(recovery['receipts'])!=len(PHASES)):
        raise failed()
    prior_file={}
    prior=_saved(tx.parent,'transaction-to-server.json',tx.owner,tx.normal_group,facts=prior_file)
    if recovery['priorJournal'] is None:
        if prior is not _ABSENT:raise failed()
    elif (type(prior) is not dict or prior.get('normal')!=recovery['normal']
          or recovery['priorJournal']!=dict(sha256=prior_file['sha256'],metadata=list(prior_file['metadata']))):raise failed()
    settlement=None
    for name,key in [('to-legacy-prior-settlement.json','priorSettlement'),('to-legacy-selection.json','selection')]:
        facts={};value=_saved(tx.parent,name,tx.owner,facts=facts)
        if value is _ABSENT or facts['sha256']!=recovery[key]:raise failed()
        if key=='priorSettlement':settlement=value
        elif (value.get('migrationNormal')!=recovery['normal'] or value.get('previousNormal')!=recovery['previousNormal']
              or value.get('layout')!=recovery['layout'] or value.get('controlled')!=recovery['controlled']):raise failed()
    if prior is _ABSENT:
        if settlement.get('actor')!='not-issued' or settlement.get('clients')!=[]:raise failed()
    elif (settlement.get('actorPid')!=prior.get('actorPid') or settlement.get('actorStartTicks')!=prior.get('actorStartTicks')):raise failed()
    for phase,reference in zip(PHASES,recovery['receipts']):
        facts={};receipt=_saved(tx.parent,'to-legacy-'+phase+'.receipt.json',tx.owner,facts=facts)
        if (type(reference) is not dict or set(reference)!={'phase','receiptSha256'} or reference['phase']!=phase
                or facts.get('sha256')!=reference['receiptSha256'] or type(receipt) is not dict
                or receipt.get('direction')!='to-legacy' or receipt.get('phase')!=phase
                or receipt.get('status')!='verified' or receipt.get('actorPid')!=recovery['actorPid']
                or receipt.get('actorStartTicks')!=recovery['actorStartTicks']):raise failed()
    selected=recovery['previousNormal']
    handoff=_saved(tx.parent,'transaction-to-legacy.json',tx.owner,tx.normal_group)
    if recovery['controlled']:
        if type(selected) is not dict or _normal(selected['path'])!=selected:raise failed()
        expected={key:recovery[key] for key in ('direction','status','actorPid','actorStartTicks','phases','admission')}
        expected.update(schema=SCHEMA,normal=selected)
        if (handoff!=expected or type(recovery['admission']) is not dict
                or recovery['admission'].get('image')!=selected['image']
                or recovery['admission'].get('token')!=selected['token']):raise failed()
    else:
        if handoff is not _ABSENT or recovery['admission'] is not None:raise failed()
        with _generation_file(selected['path'],('previous-normal.json',)) as (model,reference):
            if dict(reference,image=model['services']['bellteam']['image'])!=selected:raise failed()
    destination=Path(recovery['normal']['path']).parent/'sec014-control-history'
    if os.path.lexists(destination):raise failed()
    names=['recovery-to-legacy.json']
    if prior is not _ABSENT:names.append('transaction-to-server.json')
    if handoff is not _ABSENT:names.append('transaction-to-legacy.json')
    names+=sorted(name for name in os.listdir(tx.parent) if name.startswith(('to-server-','to-legacy-')))
    identities={}
    for name in names:
        if not re.fullmatch('[a-z0-9._-]{1,255}',name):raise failed()
        info=os.stat(name,dir_fd=tx.parent,follow_symlinks=False)
        _private(info,tx.owner,stat.S_ISDIR(info.st_mode),tx.normal_group if name in
                 ('recovery-to-legacy.json','transaction-to-server.json','transaction-to-legacy.json') else None)
        identities[name]=_identity(info)
    _selector(tx.lock,'archiving')
    with _generation_file(recovery['normal']['path'],('normal.json',)) as (_,reference):
        parent=os.open(destination.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:
            if _identity(os.fstat(parent))!=(reference['parentDevice'],reference['parentInode']):raise failed()
            os.mkdir(destination.name,mode=0o700,dir_fd=parent)
            archive=os.open(destination.name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=parent)
            try:
                os.fsync(parent)
                for name in names:
                    tx.check()
                    if (_identity(os.stat(destination.name,dir_fd=parent,follow_symlinks=False))!=_identity(os.fstat(archive))
                            or _identity(os.stat(name,dir_fd=tx.parent,follow_symlinks=False))!=identities[name]):raise failed()
                    os.rename(name,name,src_dir_fd=tx.parent,dst_dir_fd=archive)
                    os.fsync(archive);os.fsync(tx.parent)
            finally:os.close(archive)
        finally:os.close(parent)


class _Transaction:
    _docker_socket_path = Path('/var/run/docker.sock')

    def __init__(self, path, parent, lock, owner, direction, normal_group=None, normal=None):
        self.path, self.parent, self.lock, self.owner = path, parent, lock, owner
        self.normal_group, self.shared = normal_group, False
        self.parent_identity = _identity(os.fstat(parent))
        self.lock_identity = _identity(os.fstat(lock))
        self._docker_socket_original = None
        self._docker_peer_original = None
        self._writer_image_original = None
        self._prepare_originals = []
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
        if getattr(self, '_recovery_inputs', None) is not None:
            self._recovery_inputs._check_files()
        if self._docker_socket_original is not None:
            self._socket_observation()
        if self._docker_peer_original is not None:
            peer = self._docker_peer_original
            if self._docker_peer_process(peer['pid']) != peer['process']:
                raise ControlError('SEC014_CONTROL_DOCKER_PEER_CHANGED')
        if self._writer_image_original is not None:
            facts={}
            saved=_saved(self.parent,self.value['direction']+'-writer-image.output.json',self.owner,facts=facts)
            if saved!=self._writer_image_original['output'] or facts!=self._writer_image_original['file']:
                raise ControlError('SEC014_CONTROL_WRITER_IMAGE_CHANGED')
        for original in self._prepare_originals:
            facts={}
            saved=_saved(self.parent,original['name'],self.owner,facts=facts)
            if saved!=original['value'] or facts!=original['file']:
                raise ControlError('SEC014_CONTROL_PREPARE_ORIGINAL_CHANGED')

    def _socket_observation(self):
        # shortcut: point observations only, require host peer/ancestor authority before live connection.
        path=self._docker_socket_path
        namespace=os.stat('/proc/thread-self/ns/mnt')
        fd=os.open(path,os.O_PATH|os.O_NOFOLLOW|os.O_CLOEXEC)
        named=None
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
            named=os.open(path,os.O_PATH|os.O_NOFOLLOW|os.O_CLOEXEC)
            if any(getattr(info,key)!=getattr(linked,key)
                   for linked in (os.fstat(named),os.stat(path,follow_symlinks=False)) for key in keys):
                raise ControlError('SEC014_CONTROL_DOCKER_SOCKET')
            mounts=[]
            for current in (fd,named):
                with Path('/proc/thread-self/fdinfo/'+str(current)).open('rb') as stream:raw=stream.read(4097)
                ids=re.findall(rb'(?m)^mnt_id:[ \t]*([1-9][0-9]{0,19})$',raw)
                if len(raw)>4096 or len(ids)!=1 or len(re.findall(rb'(?m)^mnt_id:',raw))!=1:
                    raise ControlError('SEC014_CONTROL_DOCKER_SOCKET_MOUNT')
                mounts.append((int(ids[0]),raw.decode('ascii')))
            if mounts[0][0]!=mounts[1][0]:
                raise ControlError('SEC014_CONTROL_DOCKER_SOCKET_MOUNT')
            # shortcut: mount tables over 65536B are refused, review the observation budget before increasing.
            with Path('/proc/thread-self/mountinfo').open('rb') as stream:table=stream.read(65537)
            entries=[line for line in table.splitlines() if line.startswith(str(mounts[0][0]).encode()+b' ')]
            if len(table)>65536 or len(entries)!=1:
                raise ControlError('SEC014_CONTROL_DOCKER_SOCKET_MOUNTINFO')
            sections=entries[0].split(b' - ')
            fields=sections[0].split()
            if (len(sections)!=2 or len(fields)<6 or len(sections[1].split())!=3
                    or not re.fullmatch(rb'[1-9][0-9]{0,19}',fields[1])
                    or fields[2]!=str(os.major(info.st_dev)).encode()+b':'+str(os.minor(info.st_dev)).encode()):
                raise ControlError('SEC014_CONTROL_DOCKER_SOCKET_MOUNTINFO')
            if _identity(os.stat('/proc/thread-self/ns/mnt'))!=_identity(namespace):
                raise ControlError('SEC014_CONTROL_DOCKER_SOCKET_NAMESPACE')
            value=dict(path=str(path),dockerHost='unix://'+str(path),device=str(info.st_dev),
                inode=str(info.st_ino),uid=info.st_uid,gid=info.st_gid,
                mode=format(stat.S_IMODE(info.st_mode),'04o'),links=info.st_nlink,
                ctimeNs=str(info.st_ctime_ns),namespaceDevice=str(namespace.st_dev),
                namespaceInode=str(namespace.st_ino),mountId=mounts[0][0],fdinfoUtf8=mounts[0][1],
                mountInfoUtf8=entries[0].decode('utf-8'),accessAcl=dict(
                    rawHex=None if acl is None else acl.hex(),errno=acl_errno),hostAuthority=False)
            if len(json.dumps(value,sort_keys=True,allow_nan=False).encode())>65536:
                raise ControlError('SEC014_CONTROL_DOCKER_SOCKET_OBSERVATION_LIMIT')
            if self._docker_socket_original is not None and value!=self._docker_socket_original:
                raise ControlError('SEC014_CONTROL_DOCKER_SOCKET_CHANGED')
            return value
        finally:
            if named is not None:os.close(named)
            os.close(fd)

    def _docker_peer_process(self, pid):
        try:
            proc = Path('/proc')/str(pid)
            before = int((proc/'stat').read_text().rsplit(') ', 1)[1].split()[19])
            executable = os.readlink(proc/'exe')
            info = os.stat(proc/'exe')
            linked = os.stat(executable)
            fields = ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0
                    or info.st_mode & 0o022 or info.st_nlink < 1
                    or tuple(getattr(info, key) for key in fields) != tuple(getattr(linked, key) for key in fields)):
                raise ControlError('SEC014_CONTROL_DOCKER_PEER_EXECUTABLE')
            status = (proc/'status').read_text()
            credentials = {}
            for label, expected in (('Uid', self.owner[0]), ('Gid', self.owner[1])):
                row = re.search(r'^'+label+r':\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$', status, re.M)
                if row is None or any(int(value) != expected for value in row.groups()):
                    raise ControlError('SEC014_CONTROL_DOCKER_PEER_IDENTITY')
                credentials[label] = list(map(int, row.groups()))
            namespaces = {}
            for kind in ('mnt', 'pid', 'user'):
                observed = _identity(os.stat(proc/'ns'/kind))
                if observed != _identity(os.stat('/proc/thread-self/ns/'+kind)):
                    raise ControlError('SEC014_CONTROL_DOCKER_PEER_NAMESPACE')
                namespaces[kind] = list(observed)
            after = int((proc/'stat').read_text().rsplit(') ', 1)[1].split()[19])
            if (before != after or os.readlink(proc/'exe') != executable
                    or tuple(getattr(os.stat(proc/'exe'), key) for key in fields) != tuple(getattr(info, key) for key in fields)
                    or (proc/'status').read_text().split('Uid:',1)[1].splitlines()[0] != status.split('Uid:',1)[1].splitlines()[0]
                    or (proc/'status').read_text().split('Gid:',1)[1].splitlines()[0] != status.split('Gid:',1)[1].splitlines()[0]):
                raise ControlError('SEC014_CONTROL_DOCKER_PEER_CHANGED')
            return dict(startTicks=before, executable=dict(path=executable,
                metadata=[getattr(info, key) for key in fields]), credentials=credentials, namespaces=namespaces)
        except (OSError, ValueError, IndexError) as error:
            raise ControlError('SEC014_CONTROL_DOCKER_PEER_UNCONFIRMED') from error

    def _docker_peer(self):
        # Probe listener credentials; the native CLI uses a separate connection.
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(1)
            connection.connect(str(self._docker_socket_path))
            pid, uid, gid = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET,
                socket.SO_PEERCRED, struct.calcsize('3i')))
            if pid <= 0 or (uid, gid) != self.owner:
                raise ControlError('SEC014_CONTROL_DOCKER_PEER_IDENTITY')
            process = self._docker_peer_process(pid)
        return dict(pid=pid, uid=uid, gid=gid, process=process)

    def _docker_endpoint(self):
        self.check()
        value=self._socket_observation()
        peer=self._docker_peer()
        if self._docker_socket_original is None:self._docker_socket_original=dict(value)
        if self._docker_peer_original is None:self._docker_peer_original=peer
        if peer != self._docker_peer_original:
            raise ControlError('SEC014_CONTROL_DOCKER_PEER_CHANGED')
        self.check()
        return dict(value, peer=peer)

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
    lock = transaction = None
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
        recovery = _saved(parent, 'recovery-to-legacy.json', owner, normal_group)
        if recovery is not _ABSENT:
            if normal is None:raise ControlError('SEC014_CONTROL_RECOVERY_UNRESOLVED')
            _archive_recovery(transaction,recovery,normal)
            selector = b''
        else:
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
        # Failed actor owners keep the same kernel lock until explicit recovery.
        if transaction is None or not getattr(transaction, '_retain_control', False):
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
