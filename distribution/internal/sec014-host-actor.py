"""Fixed phase actor and private forward executor; live admission remains unaccepted."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import sys
import time
from datetime import datetime, timezone, timedelta


_spec = importlib.util.spec_from_file_location(
    'sec014_control', Path(__file__).with_name('sec014-host-control.py'))
control = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(control)
_spec = importlib.util.spec_from_file_location(
    'sec014_prepared_producer', Path(__file__).with_name('sec014-prepared-proof.py'))
prepared = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(prepared)

# A handled failure retains binding owners and prevents implicit native reaping.
_FAILED_WRITER_OWNERS = []

# Each proof is produced after checking its real artifacts, never from exit0 alone.
PROOFS = (
    ('participating_writers', 'nonparticipating_writers', 'both_normal_stopped'),
    ('host_parents', 'six_prepared_leaves'),
    ('legacy_backup', 'server_backup', 'current_direction_migration'),
    ('six_source_target_identity', 'normal_nonexposure', 'socket_boundary'),
    ('owner_operation', 'selected_normal_identity', 'no_other_normal'),
    ('health', 'current_data', 'no_unknown_children'),
)


def _receipt(tx, phase, image, value, required):
    if (type(value) is not dict
            or set(value) != {'schema', 'direction', 'phase', 'image', 'actorPid',
                             'actorStartTicks', 'status', 'proofs'}
            or value['schema'] != 'bellteam.sec014.phase-receipt.v1'
            or value['direction'] != tx.value['direction']
            or value['phase'] != phase or value['image'] != image
            or type(value['actorPid']) is not int
            or value['actorPid'] != tx.value['actorPid']
            or type(value['actorStartTicks']) is not int
            or value['actorStartTicks'] != tx.value['actorStartTicks']
            or value['status'] != 'verified' or type(value['proofs']) is not dict
            or set(value['proofs']) != set(required)
            or any(type(sha) is not str or not re.fullmatch('[a-f0-9]{64}', sha)
                   for sha in value['proofs'].values())):
        raise control.ControlError('SEC014_ACTOR_PHASE_UNCONFIRMED')
    name = tx.value['direction'] + '-' + phase + '.receipt.json'
    return _save_json(tx, name, value)


def _save_json(tx, name, value, *, facts=None, limit=65536):
    raw = json.dumps(value, sort_keys=True, allow_nan=False).encode()
    if type(limit) is not int or not 1 <= limit <= 4194304 or len(raw) > limit:
        raise control.ControlError('SEC014_ACTOR_SAVE_LIMIT')
    tx.check()
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
                 | os.O_CLOEXEC, 0o600, dir_fd=tx.parent)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
        written = os.fstat(stream.fileno())
        control._private(written, tx.owner)
        os.fsync(tx.parent)
        if control._saved(tx.parent, name, tx.owner, **({'limit': limit} if limit != 65536 else {})) != value:
            raise control.ControlError('SEC014_ACTOR_RECEIPT_CHANGED')
        # Equal JSON in a replacement inode is not the receipt we saved.
        reopened = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                           dir_fd=tx.parent)
        try:
            keys = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink',
                    'st_size', 'st_mtime_ns', 'st_ctime_ns')
            expected = tuple(getattr(written, key) for key in keys)
            observed = (os.fstat(stream.fileno()), os.fstat(reopened),
                        os.stat(name, dir_fd=tx.parent, follow_symlinks=False))
            if (written.st_size != len(raw)
                    or any(tuple(getattr(item, key) for key in keys) != expected
                           for item in observed)):
                raise control.ControlError('SEC014_ACTOR_RECEIPT_CHANGED')
            tx.check()
            if facts is not None:
                facts.update(sha256=hashlib.sha256(raw).hexdigest(),metadata=expected)
        finally:
            os.close(reopened)
    return hashlib.sha256(raw).hexdigest()


def prepare_name(tx):
    return f"sec014-{tx.value['direction']}-{tx.value['actorPid']}-{tx.value['actorStartTicks']}-prepare"


def prepare_argv(tx):
    tx.check()
    normal = tx.value.get('normal')
    if normal is not None and 'prepare' not in normal:
        raise control.ControlError('SEC014_PREPARE_GENERATION_MISSING')
    compose = normal['prepare']['path'] if normal is not None else '/home/kite/BellTeam/compose.state-prepare.yaml'
    return ['/usr/bin/docker', 'compose', '--env-file', '/dev/null', '-f',
            compose, 'run', '--no-deps',
            '--name', prepare_name(tx), '-T', 'state-prepare']


def prepared_phase_receipt(tx, image, terminal, host_parent_proof):
    """Trusted executor input only; terminal producer/host authority remain separate."""
    name, argv = prepare_name(tx), prepare_argv(tx)
    if (type(image) is not str or not re.fullmatch(
            r'(?:ghcr\.io/kitepon/bellteam-server@)?sha256:[a-f0-9]{64}', image)
            or type(host_parent_proof) is not str
            or not re.fullmatch('[a-f0-9]{64}', host_parent_proof)
            or type(terminal) is not dict
            or set(terminal) != {'schema', 'direction', 'image', 'actorPid',
                'actorStartTicks', 'clientPid', 'clientStartTicks', 'containerId',
                'containerName', 'argv', 'status', 'exitCode', 'unknown'}
            or terminal['schema'] != 'bellteam.sec014.prepare-terminal.v1'
            or terminal['direction'] != tx.value['direction']
            or terminal['image'] != image
            or any(type(terminal[key]) is not int or terminal[key] != tx.value[key]
                   for key in ('actorPid', 'actorStartTicks'))
            or any(type(terminal[key]) is not int or terminal[key] <= 0
                   for key in ('clientPid', 'clientStartTicks'))
            or type(terminal['containerId']) is not str
            or not re.fullmatch('[a-f0-9]{64}', terminal['containerId'])
            or terminal['containerName'] != name or terminal['argv'] != argv
            or terminal['status'] != 'exited' or type(terminal['exitCode']) is not int
            or terminal['exitCode'] != 0 or terminal['unknown'] is not False):
        raise control.ControlError('SEC014_PREPARE_TERMINAL_UNCONFIRMED')
    tx.check()
    metadata = prepared.read_prepared_proof()
    tx.check()
    # Retain exact metadata bytes, not only a reference to a transient return value.
    artifact = {'schema': 'bellteam.sec014.prepare-evidence.v1',
                'terminal': terminal, 'metadataUtf8': metadata.decode('utf-8'),
                'metadataSha256': hashlib.sha256(metadata).hexdigest()}
    evidence_sha = _save_json(tx, tx.value['direction'] + '-prepare-evidence.json', artifact)
    return {'schema': 'bellteam.sec014.phase-receipt.v1',
            'direction': tx.value['direction'], 'phase': 'prepared', 'image': image,
            'actorPid': tx.value['actorPid'], 'actorStartTicks': tx.value['actorStartTicks'],
            'status': 'verified', 'proofs': {'host_parents': host_parent_proof,
                                           'six_prepared_leaves': evidence_sha}}


def _run(tx, image, executor):
    """Internal executor owns real verification; no arbitrary command/argv input."""
    if type(image) is not str or not re.fullmatch(
            r'(?:ghcr\.io/kitepon/bellteam-server@)?sha256:[a-f0-9]{64}', image):
        raise control.ControlError('SEC014_ACTOR_IMAGE')
    results = []
    methods = (executor.assert_writers_stopped, executor.prepare,
               executor.backup_and_migrate, executor.assert_binds,
               executor.start_selected_normal, executor.verify_result)
    for phase, required, method in zip(control.PHASES, PROOFS, methods):
        tx.check()
        frozen = {'saved_normal': dict(tx.value['normal'])} if 'normal' in tx.value else {}
        if phase == 'started' and tx.normal_group is not None:
            selected = executor.prepare_selected_normal(direction=tx.value['direction'], image=image,
                actor_pid=tx.value['actorPid'], actor_start_ticks=tx.value['actorStartTicks'], **frozen)
            if type(selected) is not dict or set(selected) != {'container_id', 'image', 'token'}:
                raise control.ControlError('SEC014_ACTOR_SELECTION_UNCONFIRMED')
            tx.admit_normal(**selected)
        # Both aliases remain stopped until both backups, migration and binds pass.
        fields = dict(direction=tx.value['direction'], image=image,
                      actor_pid=tx.value['actorPid'], actor_start_ticks=tx.value['actorStartTicks'], **frozen)
        if phase in control.PHASES[4:] and tx.normal_group is not None:
            fields['selected_normal'] = dict(tx.value['admission'])
        receipt = method(**fields)
        sha = _receipt(tx, phase, image, receipt, required)
        tx.confirmed(phase)
        results.append({'phase': phase, 'receiptSha256': sha})
    return results


def run_actor(direction, image, executor_factory, *, saved_normal):
    if type(image) is not str or not re.fullmatch(
            r'(?:ghcr\.io/kitepon/bellteam-server@)?sha256:[a-f0-9]{64}', image):
        raise control.ControlError('SEC014_ACTOR_IMAGE')
    with control.host_control(direction, saved_normal=saved_normal) as tx:
        # Construct the executor only while this exact saved generation is held.
        try:
            executor = executor_factory(tx)
            tx.check()
            return _run(tx, image, executor)
        except BaseException:
            if getattr(tx,'_prepare_host_checks',()) or any(child.returncode is None
                   for children in (getattr(tx, '_writer_children', ()),getattr(tx, '_prepare_children', ()),getattr(tx, '_native_children', ()))
                   for child, _ in children):
                tx._retain_control = True
                _FAILED_WRITER_OWNERS.append(tx)
            raise


class _InternalForward:
    """Unwired draft: runtime denominator and recovery checks must pass before use."""
    ROOT = Path('/home/kite/BellTeam')
    SERVER_UID = 1001

    def __init__(self, tx, stopped_container):
        self.tx = tx
        if tx.value['direction'] != 'to-server' or not re.fullmatch('[a-f0-9]{64}', stopped_container):
            raise control.ControlError('SEC014_INTERNAL_SELECTION')
        self.old = stopped_container
        self.normal = tx.value['normal']
        self.image_id = self.normal['image']
        self.image = self.normal.get('imageRef', self.image_id)
        models = {}
        control._normal(self.normal['path'], models=models)
        if set(models) != {'bellteam', 'state-prepare', 'state-maintenance'} or models['bellteam'].get('name') != 'bellteam':
            raise control.ControlError('SEC014_INTERNAL_GENERATION')
        self.models = models
        service = dict(models['state-maintenance']['services']['state-maintenance'])
        expected = json.loads((Path(__file__).resolve().parents[2]/'compose.state-maintenance.json').read_bytes())['services']['state-maintenance']
        expected['image'] = self.image_id
        expected['mem_limit'] = expected['memswap_limit'] = 2147483648
        for key in ('mem_limit','memswap_limit'):
            if service.get(key) == '2147483648':
                service[key] = 2147483648
        if type(service.get('cpus')) is float and service['cpus'] == 1:
            service['cpus'] = 1
        expected['volumes'] = service.get('volumes')
        if json.dumps(service, sort_keys=True, allow_nan=False) != json.dumps(expected, sort_keys=True):
            raise control.ControlError('SEC014_INTERNAL_MAINTENANCE_CONFIG')
        normal_service = models['bellteam']['services']['bellteam']
        if (normal_service.get('read_only') is not True or normal_service.get('privileged', False) is not False
                or normal_service.get('cap_add') or normal_service.get('devices')
                or any(normal_service.get(key) == 'host' for key in ('pid','ipc','network_mode'))):
            raise control.ControlError('SEC014_INTERNAL_NORMAL_CONFIG')
        parent = control.CONTROL.parent.resolve()
        prepared_parent = Path(self.normal['prepare']['service']['volumes'][0]['source'])
        protected = {('/srv/bellteam/'+('shared/tools/'+leaf if leaf in ('bellteam-settings','apns') else leaf)):
                     prepared_parent/leaf for leaf in prepared.LEAVES}
        for mount in normal_service['volumes']:
            if mount['type'] != 'bind':
                continue
            source, target = Path(mount['source']).resolve(), mount['target']
            if target == '/run/bellteam-maintenance':
                if source != control.CONTROL or mount.get('read_only') is not True:
                    raise control.ControlError('SEC014_INTERNAL_NORMAL_EXPOSURE')
                continue
            if target in protected:
                if source != protected[target]:
                    raise control.ControlError('SEC014_INTERNAL_NORMAL_EXPOSURE')
            elif source.is_relative_to(parent) or parent.is_relative_to(source):
                raise control.ControlError('SEC014_INTERNAL_NORMAL_EXPOSURE')
            socket = self.tx._docker_socket_path.resolve()
            if source.is_relative_to(socket) or socket.is_relative_to(source):
                raise control.ControlError('SEC014_INTERNAL_NORMAL_EXPOSURE')
        self.deadline = time.monotonic()+40
        self.end = datetime.now(timezone.utc)+timedelta(seconds=40)
        self.failed = False
        self.cid = None
        self.serial = 0
        self.native = tx._native_children = []
        self.transfer = None
        self.data_proof = None
        spec = importlib.util.spec_from_file_location('sec014_forward_writer', Path(__file__).with_name('sec014-writer-collector.py'))
        self.writer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.writer)
        self.node = self.writer.NODE_EXECUTABLE
        spec = importlib.util.spec_from_file_location('sec014_forward_prepare', Path(__file__).with_name('sec014-prepare-executor.py'))
        self.preparer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.preparer)
        self.baseline = self._host()
        self.host_proof = _save_json(tx, 'to-server-host-original.json', self.baseline)
        tx._prepare_host_checks = [self]
        self.config = tx.path/'to-server-internal-empty-docker-config'
        self.config.mkdir(mode=0o700)
        self.env = {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'LANG': 'C.UTF-8',
                    'DOCKER_HOST': tx._docker_endpoint()['dockerHost'], 'DOCKER_CONFIG': str(self.config)}

    def _host(self):
        if any(x != 0 for x in (os.getuid(), os.geteuid(), os.getgid(), os.getegid())):
            raise control.ControlError('SEC014_INTERNAL_ROOT_REQUIRED')
        self.tx.check()
        endpoint = self.tx._docker_endpoint()
        executables = {}
        fields = ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
        source_root = Path(__file__).resolve().parents[2]
        dependencies = [str(Path(__file__).with_name(name)) for name in (
            'sec014-host-actor.py','sec014-host-control.py','sec014-prepared-proof.py',
            'sec014-prepare-executor.py','sec014-writer-collector.py','sec014-writer-snapshot.mjs')]
        dependencies.extend(str(source_root/name) for name in ('src/server-state-writers.mjs','compose.state-prepare.yaml','compose.state-maintenance.json'))
        plugins = [path for folder in ('/usr/local/lib/docker/cli-plugins','/usr/local/libexec/docker/cli-plugins',
                                      '/usr/lib/docker/cli-plugins','/usr/libexec/docker/cli-plugins')
                   if (path := Path(folder)/'docker-compose').exists()]
        if not plugins or self.normal['owner'] != [0, 0]:
            raise control.ControlError('SEC014_INTERNAL_TRUST_NOT_INSTALLED')
        for name in ('/usr/bin/docker', sys.executable, self.node, *dependencies, *map(str, plugins)):

            if name is None:
                raise control.ControlError('SEC014_INTERNAL_CLI_IDENTITY')
            cli = Path(name)
            info = cli.stat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise control.ControlError('SEC014_INTERNAL_CLI_IDENTITY')
            for parent in set(cli.absolute().parents) | set(cli.resolve().parents):
                value = parent.stat()
                if value.st_uid != 0 or value.st_mode & 0o022:
                    raise control.ControlError('SEC014_INTERNAL_CLI_ANCESTOR')
            executables[name] = {'path': str(cli.resolve()), 'metadata': [getattr(info, key) for key in fields]}
        socket_mode = int(endpoint['mode'], 8)
        if (endpoint['uid'] != 0 or socket_mode & 0o007
                or endpoint['gid'] in (1000, 1001) and socket_mode & 0o060
                or endpoint['accessAcl']['rawHex'] is not None):
            raise control.ControlError('SEC014_INTERNAL_SOCKET_ACCESS')
        ancestors = {}
        for parent in Path(endpoint['path']).parents:
            info = parent.stat()
            if info.st_uid != 0 or info.st_mode & 0o022:
                raise control.ControlError('SEC014_INTERNAL_SOCKET_ANCESTOR')
            ancestors[str(parent)] = [info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode]
        parent = control.CONTROL.parent/'state-data'
        control._private(parent.lstat(), self.tx.owner, True)
        fields = ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
        return {'actorPid': self.tx.value['actorPid'], 'actorStartTicks': self.tx.value['actorStartTicks'],
                'cli': executables,
                'socket': endpoint, 'socketAncestors': ancestors, 'stateParent': {'device': str(parent.stat().st_dev), 'inode': str(parent.stat().st_ino)},
                'scope': 'trusted root management entry; ordinary seats excluded; no arbitrary-root resistance'}

    def __call__(self, step):
        if self.failed or time.monotonic() >= self.deadline or datetime.now(timezone.utc) >= self.end or self._host() != self.baseline:
            raise control.ControlError('SEC014_INTERNAL_HOST_CHANGED_OR_HELD')
        return self.host_proof

    def bind_image(self, image, image_id, original):
        self('bind_image')
        if image != self.image or image_id != self.image_id or original != self.tx._writer_image_original:
            raise control.ControlError('SEC014_INTERNAL_IMAGE_PAIR')

    def invalidate(self, reason):
        self.failed = True
        _save_json(self.tx, 'to-server-internal-unknown.json', {'reason': reason, 'selectedContainer': self.cid})

    def compose(self, role, *args):
        path = self.normal['path'] if role == 'bellteam' else self.normal['maintenance']['path']
        return ['/usr/bin/docker', 'compose', '--env-file', '/dev/null', '--project-directory', str(self.ROOT),
                '-p', 'bellteam', '-f', path, *args]

    def call(self, slot, argv, limit=1048576, *, data=None):
        self(slot)
        self.serial += 1
        name = 'to-server-internal-'+str(self.serial)+'-'+slot
        _save_json(self.tx, name+'.claim.json', {'argv': argv, 'image': self.image, 'imageId': self.image_id})
        source = None
        if data is not None:
            _save_json(self.tx, name+'.input.json', data, limit=4194304)
            source = (self.tx.path/(name+'.input.json')).open('rb')
        issued_at = datetime.now(timezone.utc).isoformat()
        try:
            child = subprocess.Popen(argv, cwd=self.ROOT, env=self.env, stdin=source if source else subprocess.DEVNULL,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True)
        finally:
            if source:
                source.close()
        self.native.append((child, None))
        born = int(Path(f'/proc/{child.pid}/stat').read_text().rsplit(') ', 1)[1].split()[19])
        self.native[-1] = (child, born)
        _save_json(self.tx, name+'.spawn.json', {'pid': child.pid, 'startTicks': born})
        output, error, terminal = bytearray(), bytearray(), None
        with selectors.DefaultSelector() as selector:
            for stream, target, cap in ((child.stdout, output, limit), (child.stderr, error, 8192)):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, (target, cap))
            while terminal is None or selector.get_map():
                left = self.deadline-time.monotonic()
                if left <= 0:
                    raise control.ControlError('SEC014_INTERNAL_CHILD_UNKNOWN')
                for key, _ in selector.select(min(left, .02)):
                    raw = os.read(key.fd, 32768)
                    target, cap = key.data
                    if not raw:
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
                    elif len(target)+len(raw) > cap:
                        raise control.ControlError('SEC014_INTERNAL_OUTPUT_LIMIT')
                    else:
                        target.extend(raw)
                seen = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOWAIT | os.WNOHANG)
                if seen:
                    terminal = {'kind': 'exit' if seen.si_code == os.CLD_EXITED else 'signal', 'code': seen.si_status}
        record = {'argv': argv, 'clientPid': child.pid, 'clientStartTicks': born, 'terminal': terminal,
                  'issuedAt': issued_at, 'endedAt': datetime.now(timezone.utc).isoformat(),
                  'rawUtf8': output.decode('utf-8'), 'unknown': False, 'stdoutBytes': len(output), 'stdoutSha256': hashlib.sha256(output).hexdigest(),
                  'stderrBytes': len(error), 'stderrSha256': hashlib.sha256(error).hexdigest()}
        _save_json(self.tx, name+'.output.json', record, limit=4194304)
        if terminal != {'kind': 'exit', 'code': 0}:
            raise control.ControlError('SEC014_INTERNAL_CHILD_FAILED')
        self(slot)
        return record

    def reap(self):
        for child, born in self.native:
            if child.returncode is not None:
                continue
            current = int(Path(f'/proc/{child.pid}/stat').read_text().rsplit(') ', 1)[1].split()[19])
            if current != born or child.wait(timeout=min(1, self.deadline-time.monotonic())) != 0:
                raise control.ControlError('SEC014_INTERNAL_REAP_UNCONFIRMED')

    def receipt(self, phase, **proofs):
        if set(proofs) != set(PROOFS[control.PHASES.index(phase)]):
            raise control.ControlError('SEC014_INTERNAL_PROOF_FIELDS')
        self(phase)
        self.reap()
        return {'schema': 'bellteam.sec014.phase-receipt.v1', 'direction': 'to-server', 'phase': phase,
                'image': self.image, 'actorPid': self.tx.value['actorPid'],
                'actorStartTicks': self.tx.value['actorStartTicks'], 'status': 'verified', 'proofs': proofs}

    def inspect(self, cid, slot):
        template = '{"id":{{json .Id}},"image":{{json .Image}},"configImage":{{json .Config.Image}},' \
            '"state":{{json .State}},"user":{{json .Config.User}},"mounts":{{json .Mounts}},' \
            '"readonly":{{json .HostConfig.ReadonlyRootfs}},"tmpfs":{{json .HostConfig.Tmpfs}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"project":{{json (index .Config.Labels "com.docker.compose.project")}}}'
        record = self.call(slot, ['/usr/bin/docker', 'inspect', '--type', 'container', '--format', template, cid])
        value = json.loads(record['rawUtf8'])
        if value.get('id') != cid or value.get('service') != 'bellteam' or value.get('project') != 'bellteam':
            raise control.ControlError('SEC014_INTERNAL_CONTAINER_IDENTITY')
        return value, _save_json(self.tx, 'to-server-'+slot+'.verified.json', value)

    def assert_writers_stopped(self, **fields):
        stopped, old_proof = self.inspect(self.old, 'stopped-normal')
        if stopped['state']['Running'] or stopped['state'].get('Restarting'):
            raise control.ControlError('SEC014_INTERNAL_NORMAL_RUNNING')
        proof = self.writers('initial-writers')
        return self.receipt('writers_stopped', participating_writers=proof,
                            nonparticipating_writers=self.host_proof, both_normal_stopped=old_proof)

    def query(self, slot, stage, **fields):
        record = self.call(slot, [self.node, '--input-type=module', '-e', self.writer.NODE],
                           data=dict(stage=stage, **fields))
        return json.loads(record['rawUtf8'])

    def writers(self, slot, active=None):
        plan = self.query(slot+'-plan', 'plan', config=self.tx._writer_config(), image=self.image, imageId=self.image_id)
        image = self.call(slot+'-image', plan['imageArgv'], 128)
        if json.loads(image['rawUtf8']) != self.image_id:
            raise control.ControlError('SEC014_INTERNAL_IMAGE_PAIR')
        listed = self.call(slot+'-list', self.writer.LIST, 8320)
        ids = listed['rawUtf8'].splitlines()
        if len(ids) > 128 or len(ids) != len(set(ids)) or any(not re.fullmatch('[a-f0-9]{64}', cid) for cid in ids):
            raise control.ControlError('SEC014_INTERNAL_CONTAINER_IDS')
        inspected = self.call(slot+'-containers', self.query(slot+'-inspect-argv', 'inspect', ids=ids)) if ids else None
        containers = [json.loads(row) for row in inspected['rawUtf8'].splitlines() if row] if inspected else []
        commands = self.query(slot+'-volumes', 'volumes', plan=plan, containers=containers)
        if len(commands) > 128:
            raise control.ControlError('SEC014_INTERNAL_VOLUME_LIMIT')
        volumes = [self.call(slot+'-volume-'+str(index), argv, 16384) for index, argv in enumerate(commands)]
        backing = [json.loads(row['rawUtf8']) for row in volumes]
        sources = self.query(slot+'-sources', 'sources', plan=plan, containers=containers, volumes=backing)
        canonical = []
        for item in sources:
            path = Path(item['source'])
            canonical.append({'source': str(path), 'canonical': str(path.resolve(strict=item['observed']))})
        context = {}
        if self.old in ids:
            context['stoppedContainer'] = self.old
        if active is not None:
            context['activeContainer'] = active
        observation = self.query(slot+'-verify', 'verify', plan=plan,
            bundle=dict(image=image, list=listed, containers=inspected, volumes=volumes, canonical=canonical), context=context)
        if self.tx._writer_image_original is None:
            facts = {}
            digest = _save_json(self.tx, 'to-server-writer-image.output.json', image, facts=facts)
            self.tx._writer_image_original = dict(output=image, sha256=digest, file=facts)
        return _save_json(self.tx, 'to-server-'+slot+'.verified.json', observation)

    def prepare(self, **fields):
        result = self.preparer._Prepare(self.tx, self.image, self.image_id, self.deadline, self.end, self).prepare()
        self.reap()
        return result

    def backup_and_migrate(self, **fields):
        name = prepare_name(self.tx).removesuffix('-prepare')+'-maintenance'
        record = self.call('maintenance', self.compose('state-maintenance', 'run', '--no-deps', '--name', name,
                                                      '-T', 'state-maintenance', 'to-server'))
        value = json.loads(record['rawUtf8'])
        if (value.get('direction') != 'to-server' or value.get('status') not in ('transferred', 'fresh', 'already-transferred')
                or value.get('ownership', {}).get('direction') != 'to-server' or set(value.get('backups', {})) != {'legacy', 'server'}):
            raise control.ControlError('SEC014_INTERNAL_MIGRATION_UNCONFIRMED')
        inspected = self.call('maintenance-inspect', ['/usr/bin/docker', 'inspect', '--type', 'container',
            '--format', self.preparer.TEMPLATE, name])
        instance = json.loads(inspected['rawUtf8'])
        wanted = dict(name='/'+name, imageRef=self.image_id, imageId=self.image_id,
            service='state-maintenance', project='bellteam', status='exited', running=False,
            pid=0, exitCode=0, oom=False, user='0:0', ro=True, network='none', restarts=0, init=True,
            entrypoint=['/usr/bin/env','-i','PATH=/usr/local/bin:/usr/bin:/bin','/usr/local/bin/node','/app/src/server-state-transfer.mjs'],
            command=['to-server'], memory=2147483648, swap=2147483648, cpu=1000000000, pids=512,
            drop=['ALL'], security=['no-new-privileges:true'], tmpfs={'/tmp':'rw,nosuid,nodev,size=64m'})
        if (any(instance.get(key) != expected or type(instance.get(key)) is not type(expected)
                for key, expected in wanted.items())
                or not re.fullmatch('[a-f0-9]{64}', instance.get('id', ''))
                or sorted(cap.removeprefix('CAP_') for cap in instance.get('caps', [])) != ['CHOWN', 'DAC_OVERRIDE', 'FOWNER']):
            raise control.ControlError('SEC014_INTERNAL_MAINTENANCE_IDENTITY')
        dates = [datetime.fromisoformat(instance[key].replace('Z','+00:00')) for key in ('createdAt','startedAt','finishedAt')]
        if (any(value.utcoffset() is None for value in dates)
                or not datetime.fromisoformat(record['issuedAt']) <= dates[0] <= dates[1] <= dates[2] <= datetime.fromisoformat(record['endedAt'])):
            raise control.ControlError('SEC014_INTERNAL_MAINTENANCE_BIRTH')
        service = self.models['state-maintenance']['services']['state-maintenance']
        self.mounts(service, instance['mounts'], instance['tmpfs'])
        maintenance_id = instance['id']
        removed = self.call('maintenance-remove', ['/usr/bin/docker', 'rm', maintenance_id])
        absent = self.call('maintenance-absence', ['/usr/bin/docker', 'container', 'ls', '--all', '--quiet', '--no-trunc',
                                                   '--filter', 'id='+maintenance_id])
        if removed['rawUtf8'].strip() != maintenance_id or absent['rawUtf8'].strip():
            raise control.ControlError('SEC014_INTERNAL_MAINTENANCE_REMOVAL')
        _save_json(self.tx, 'to-server-maintenance-container.verified.json', instance)
        backups = [v['source'] for v in service['volumes'] if v.get('target') == '/srv/bellteam-maintenance-backups']
        if len(backups) != 1:
            raise control.ControlError('SEC014_INTERNAL_BACKUP_PARENT')
        proofs = {}
        for view in ('legacy', 'server'):
            expected = '/srv/bellteam-maintenance-backups/'+view+'/before-to-server/complete.json'
            receipt = value['backups'][view].get('receipt', {})
            if value['backups'][view].get('status') != 'created' or receipt.get('path') != expected:
                raise control.ControlError('SEC014_INTERNAL_BACKUP_UNCONFIRMED')
            root = Path(backups[0])
            if root.resolve(strict=True) != root:
                raise control.ControlError('SEC014_INTERNAL_BACKUP_PARENT')
            fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            try:
                control._private(os.fstat(fd), self.tx.owner, True)
                for part in (view, 'before-to-server'):
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                    os.close(fd)
                    fd = child
                    control._private(os.fstat(fd), self.tx.owner, True)
                facts = {}
                marker = control._saved(fd, 'complete.json', self.tx.owner, facts=facts)
            finally:
                os.close(fd)
            if (marker != {'schema':'bellteam.state-backup.v1','direction':'to-server','status':'complete'}
                    or facts.get('sha256') != receipt.get('sha256')
                    or [str(n) for n in facts['metadata'][:2]] != [receipt.get('device'), receipt.get('inode')]):
                raise control.ControlError('SEC014_INTERNAL_BACKUP_CHANGED')
            proofs[view+'_backup'] = _save_json(self.tx, 'to-server-'+view+'-backup.verified.json',
                {'device': receipt['device'], 'inode': receipt['inode'], 'receipt': marker, 'sha256': receipt['sha256']})
        self.transfer = value
        proofs['current_direction_migration'] = _save_json(self.tx, 'to-server-migration.verified.json', value)
        return self.receipt('migrated', **proofs)

    def assert_binds(self, **fields):
        roots = self.models['bellteam']['services']['bellteam']['volumes']
        leaves = {}
        for mount in roots:
            if mount.get('type') != 'bind' or mount.get('target') not in (
                    '/srv/bellteam/state', '/srv/bellteam/rooms', '/srv/bellteam/owner', '/srv/bellteam/logs',
                    '/srv/bellteam/shared/tools/bellteam-settings', '/srv/bellteam/shared/tools/apns'):
                continue
            path = Path(mount['source'])
            info = path.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != self.SERVER_UID or info.st_mode & 0o022:
                raise control.ControlError('SEC014_INTERNAL_STATE_OWNERSHIP')
            leaves[mount['target']] = {'source': str(path), 'device': str(info.st_dev), 'inode': str(info.st_ino), 'mode': info.st_mode}
        if len(leaves) != 6:
            raise control.ControlError('SEC014_INTERNAL_STATE_BINDS')
        selected = self.prepare_selected_normal(**fields)
        proof = _save_json(self.tx, 'to-server-bind-sources.verified.json',
                           {'leaves': leaves, 'selectedContainer': selected['container_id'], 'normalMountsVerified': True})
        return self.receipt('binds_confirmed', six_source_target_identity=proof,
                            normal_nonexposure=proof, socket_boundary=self.host_proof)

    def mounts(self, service, mounts, observed_tmpfs):
        expected = {v['target']: v for v in service['volumes']}
        tmpfs = {entry.split(':', 1)[0] for entry in service.get('tmpfs', [])}
        if set(observed_tmpfs or {}) != tmpfs:
            raise control.ControlError('SEC014_INTERNAL_SELECTED_TMPFS')
        seen = set()
        for mount in mounts:
            target = mount.get('Destination')
            if mount.get('Type') == 'tmpfs' and target in tmpfs:
                continue
            planned = expected.get(target)
            if planned is None or target in seen or mount.get('Type') != planned['type'] or mount.get('RW') == planned.get('read_only', False):
                raise control.ControlError('SEC014_INTERNAL_SELECTED_MOUNTS')
            if planned['type'] == 'bind':
                if control._identity(os.stat(mount['Source'])) != control._identity(os.stat(planned['source'])):
                    raise control.ControlError('SEC014_INTERNAL_SELECTED_MOUNTS')
            elif planned['type'] == 'volume':
                if mount.get('Name') != self.models['bellteam']['volumes'][planned['source']]['name']:
                    raise control.ControlError('SEC014_INTERNAL_SELECTED_MOUNTS')
            else:
                raise control.ControlError('SEC014_INTERNAL_SELECTED_MOUNTS')
            seen.add(target)
        if seen != set(expected):
            raise control.ControlError('SEC014_INTERNAL_SELECTED_MOUNTS')

    def data_before_start(self):
        service = self.models['bellteam']['services']['bellteam']
        roots = {v['target'].removeprefix('/srv/bellteam/'): Path(v['source'])
                 for v in service['volumes'] if v['type'] == 'bind' and v['target'].startswith('/srv/bellteam/')}
        backup = next(Path(v['source']) for v in self.models['state-maintenance']['services']['state-maintenance']['volumes']
                      if v['target'] == '/srv/bellteam-maintenance-backups')
        pairs = {'shared/subscription.json':'state/subscription.json', 'shared/onboarding.json':'state/onboarding.json',
                 'shared/ai-control.json':'state/ai-control.json', 'shared/tools/call-bridge/headers':'state/call-bridge/headers'}
        manifest = hashlib.sha256()
        count = 0
        def digest(path):
            self('current-data')
            if path.resolve(strict=True) != path:
                raise control.ControlError('SEC014_INTERNAL_CURRENT_DATA_LINK')
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
            try:
                before = os.fstat(fd)
                if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                    raise control.ControlError('SEC014_INTERNAL_CURRENT_DATA_FILE')
                sha = hashlib.sha256()
                while True:
                    self('current-data')
                    chunk = os.read(fd, 65536)
                    if not chunk:
                        break
                    sha.update(chunk)
                fields = ('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns')
                expected = tuple(getattr(before, key) for key in fields)
                if any(tuple(getattr(observed, key) for key in fields) != expected
                       for observed in (os.fstat(fd), path.lstat())):
                    raise control.ControlError('SEC014_INTERNAL_CURRENT_DATA_CHANGED')
                return sha.hexdigest()
            finally:
                os.close(fd)
        def compare(base, path):
            nonlocal count
            self('current-data')
            info = path.lstat()
            if stat.S_ISDIR(info.st_mode):
                for child in sorted(path.iterdir()):
                    compare(base, child)
                return
            name = path.relative_to(base).as_posix()
            if name == 'complete.json':
                return
            target = pairs.get(name, 'state/'+name if name.startswith('bots/') else name)
            matches = [key for key in roots if target == key or target.startswith(key+'/')]
            if len(matches) != 1:
                raise control.ControlError('SEC014_INTERNAL_CURRENT_DATA_MAPPING')
            key = matches[0]
            current = roots[key]/target[len(key):].lstrip('/')
            original = digest(path)
            if digest(current) != original:
                raise control.ControlError('SEC014_INTERNAL_CURRENT_DATA_MISMATCH')
            manifest.update(json.dumps([name, target, original], separators=(',',':')).encode()+b'\n')
            count += 1
        for view in ('legacy','server'):
            base = backup/view/'before-to-server'
            compare(base, base)
        return _save_json(self.tx, 'to-server-offline-data.verified.json',
                          {'verifiedFiles': count, 'manifestSha256': manifest.hexdigest(), 'scope': 'both latest backups compared before normal start'})

    def prepare_selected_normal(self, **fields):
        raw = self.cid
        if raw is None:
            self.data_proof = self.data_before_start()
            self.call('create-normal', self.compose('bellteam', 'create', '--no-build', '--pull', 'never', 'bellteam'))
            raw = self.call('selected-normal', self.compose('bellteam', 'ps', '--all', '--quiet', '--no-trunc', 'bellteam'))['rawUtf8'].strip()
        if not re.fullmatch('[a-f0-9]{64}', raw) or raw == self.old:
            raise control.ControlError('SEC014_INTERNAL_SELECTED_ID')
        value, _ = self.inspect(raw, 'selected-normal-inspect-'+str(self.serial))
        if (value['image'] != self.image_id or value['configImage'] != self.image_id or value['state']['Running']
                or value['user'] != str(self.SERVER_UID)+':'+str(self.SERVER_UID) or value['readonly'] is not True):
            raise control.ControlError('SEC014_INTERNAL_SELECTED_CONFIG')
        service = self.models['bellteam']['services']['bellteam']
        self.mounts(service, value['mounts'], value.get('tmpfs'))
        self.cid = raw
        return {'container_id': raw, 'image': self.image_id, 'token': self.normal['token']}

    def start_selected_normal(self, **fields):
        if fields.get('selected_normal') != self.tx.value.get('admission') or self.tx.value['admission']['containerId'] != self.cid:
            raise control.ControlError('SEC014_INTERNAL_ADMISSION')
        raw = self.call('start-normal', ['/usr/bin/docker', 'start', self.cid])['rawUtf8'].strip()
        if raw != self.cid:
            raise control.ControlError('SEC014_INTERNAL_START_UNKNOWN')
        value, proof = self.inspect(self.cid, 'started-normal')
        if value['image'] != self.image_id or value['state']['Running'] is not True:
            raise control.ControlError('SEC014_INTERNAL_START_UNKNOWN')
        other = self.writers('started-writers', active=self.cid)
        return self.receipt('started', owner_operation=proof, selected_normal_identity=proof, no_other_normal=other)

    def verify_result(self, **fields):
        for attempt in range(120):
            value, runtime = self.inspect(self.cid, 'health-'+str(attempt))
            health = value['state'].get('Health', {}).get('Status')
            if value['image'] != self.image_id or value['state']['Running'] is not True:
                raise control.ControlError('SEC014_INTERNAL_NORMAL_FAILED')
            if health == 'healthy':
                break
            if health != 'starting':
                raise control.ControlError('SEC014_INTERNAL_HEALTH_FAILED')
            self.reap()
            time.sleep(min(.2, max(0, self.deadline-time.monotonic())))
        else:
            raise control.ControlError('SEC014_INTERNAL_HEALTH_UNKNOWN')
        node = "fetch('http://127.0.0.1:4180/healthz').then(async r=>{if(r.status!==200)throw Error('health');console.log(JSON.stringify({status:r.status}))}).catch(()=>process.exitCode=1)"
        response = self.call('http-health', ['/usr/bin/docker', 'exec', '--user', '1001:1001', self.cid,
                                            '/usr/local/bin/node', '-e', node])
        if json.loads(response['rawUtf8']) != {'status': 200} or self.transfer is None or self.data_proof is None:
            raise control.ControlError('SEC014_INTERNAL_RESULT_UNCONFIRMED')
        health_proof = _save_json(self.tx, 'to-server-health.verified.json', {'container': self.cid, 'runtime': runtime, 'http': 200})
        self.mounts(self.models['bellteam']['services']['bellteam'], value['mounts'], value.get('tmpfs'))
        data_proof = _save_json(self.tx, 'to-server-current-data.verified.json',
                               {'offlineProof': self.data_proof, 'selectedContainer': self.cid, 'runtimeProof': runtime})
        self.reap()
        children = [*self.native, *getattr(self.tx, '_prepare_children', ()), *getattr(self.tx, '_writer_children', ())]
        if any(child.returncode != 0 for child, _ in children):
            raise control.ControlError('SEC014_INTERNAL_CHILDREN_UNKNOWN')
        child_proof = _save_json(self.tx, 'to-server-children.verified.json',
            [{'pid': child.pid, 'startTicks': born, 'exitCode': child.returncode} for child, born in children])
        return self.receipt('verified', health=health_proof, current_data=data_proof, no_unknown_children=child_proof)
