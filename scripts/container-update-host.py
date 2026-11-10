#!/usr/bin/python3
"""Fixed Unix update admission and a separately managed one-shot Host worker."""
import contextlib
import ctypes
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import socket
import socketserver
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid

PREFIX = Path('/srv/bellteam/shared/tools/bellteam-container-update-host')
LIMIT = 64 * 1024
CATALOG_LIMIT = 1024 * 1024
TERMINAL = {'completed', 'failed'}
JOB_STATES = ['queued', 'downloading', 'verifying', 'swapping', 'ready', 'failed']
JOB_RETAIN = 256
MODULES = {'web-gateway', 'notifications', 'members', 'memory', 'usage', 'diagnostics', 'conversation', 'execution', 'work-graph'}
# Z-b2 fixed runtime targets; same set as runtime_update.COMPONENTS (docs/architecture/modules/runtime/runtime-updates.md).
RUNTIMES = {'runtime-aiterm-mcp', 'runtime-codex', 'runtime-claude-code', 'runtime-throughline'}
POINTERS = ['current.json', 'module-current.json', 'runtime-current.json']

def job_kind(component):
    return 'container' if component == 'container' else 'runtime' if component in RUNTIMES else 'module'

class Failure(Exception):
    def __init__(self, code, status=503, outcome='not_accepted', *, path=None, reason=None):
        self.code, self.status, self.outcome = code, status, outcome
        self.path, self.reason = path, reason

def check(value, code='HOST_UPDATE_ARGUMENTS', status=400):
    if not value:
        raise Failure(code, status)

def exact(value, fields):
    return type(value) is dict and set(value) == set(fields.split(','))

def request_id(value):
    try:
        check(type(value) is str and str(uuid.UUID(value, version=4)) == value)
    except (ValueError, AttributeError):
        raise Failure('HOST_UPDATE_ARGUMENTS', 400)
    return value

def digest(value):
    check(type(value) is str and re.fullmatch('[a-f0-9]{64}', value))
    return value

def publish_directory(source, target):
    libc = ctypes.CDLL(None, use_errno=True)
    check(hasattr(libc, 'renameat2'), 'HOST_UPDATE_NOREPLACE_UNAVAILABLE')
    if libc.renameat2(-100, os.fsencode(source), -100, os.fsencode(target), 1):
        raise Failure('HOST_UPDATE_PUBLICATION_FAILED')

def stamp():
    return dt.datetime.now(dt.timezone.utc).isoformat()

def parse_time(value):
    try:
        result = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        check(result.tzinfo is not None)
        return result.timestamp()
    except (TypeError, ValueError, AttributeError):
        raise Failure('HOST_UPDATE_TIME_INVALID')

def decode(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            check(key not in result)
            result[key] = value
        return result
    try:
        def constant(_value):
            raise Failure('HOST_UPDATE_JSON_INVALID', 400)
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, UnicodeError):
        raise Failure('HOST_UPDATE_JSON_INVALID', 400)

def trusted(path, uid=0, directory=False):
    path = Path(path)
    check(path.is_absolute(), 'HOST_UPDATE_TRUST')
    for item in [*reversed(path.parents), path]:
        info = item.lstat()
        check(not stat.S_ISLNK(info.st_mode) and info.st_uid in {0, uid} and not info.st_mode & 0o22,
              'HOST_UPDATE_TRUST')
    info = path.lstat()
    check(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
          'HOST_UPDATE_TRUST')
    return info

def read_json(path, uid=0, limit=LIMIT):
    trusted(path, uid)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info, linked = os.fstat(fd), Path(path).lstat()
        check((info.st_dev, info.st_ino) == (linked.st_dev, linked.st_ino) and info.st_size <= limit,
              'HOST_UPDATE_TRUST')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            raw = stream.read(limit + 1)
        check(len(raw) <= limit, 'HOST_UPDATE_JSON_LIMIT')
        return decode(raw)
    finally:
        os.close(fd)

def atomic(path, value, limit=LIMIT):
    path = Path(path)
    raw = (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
    check(len(raw) <= limit, 'HOST_UPDATE_STATE_LIMIT')
    fd, temporary = tempfile.mkstemp(prefix='.write-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw); stream.flush(); os.fchmod(stream.fileno(), 0o600); os.fsync(stream.fileno())
        os.replace(temporary, path)
        parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)

@contextlib.contextmanager
def locked(path, wait=False):
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        check(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600,
              'HOST_UPDATE_LOCK')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | (0 if wait else fcntl.LOCK_NB))
        except BlockingIOError:
            raise Failure('HOST_UPDATE_BUSY', 409)
        yield
    finally:
        os.close(fd)

def birth(pid):
    try:
        return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
    except (OSError, IndexError):
        return None

def verify_model_mounts(normal, mounts, specs):
    check(type(mounts) is list and type(specs) is list, 'HOST_UPDATE_STORAGE_BINDING')
    configured = normal.get('services', {}).get('bellteam', {}).get('volumes')
    check(type(configured) is list, 'HOST_UPDATE_STORAGE_BINDING')
    for mount in configured:
        check(type(mount) is dict and mount.get('type') in {'bind','volume'}, 'HOST_UPDATE_STORAGE_BINDING')
        actual = [value for value in mounts if value.get('Destination') == mount.get('target')]
        check(len(actual) == 1 and actual[0].get('Type') == mount['type'] and actual[0].get('RW') is (not mount.get('read_only', False)), 'HOST_UPDATE_STORAGE_BINDING')
        if mount['type'] == 'bind':
            check(actual[0].get('Source') == mount.get('source'), 'HOST_UPDATE_STORAGE_BINDING')
        else:
            name = normal.get('volumes', {}).get(mount.get('source'), {}).get('name')
            matched = [value for value in specs if value.get('Target') == mount['target']]
            check(type(name) is str and actual[0].get('Name') == name, 'HOST_UPDATE_STORAGE_BINDING')
            if not matched and not mount.get('volume', {}).get('nocopy') and not mount.get('volume', {}).get('subpath'):
                continue
            check(len(matched) == 1 and matched[0].get('Source') == name and bool(matched[0].get('ReadOnly')) is bool(mount.get('read_only',False))
                  and matched[0].get('VolumeOptions',{}).get('Subpath','') == mount.get('volume',{}).get('subpath','')
                  and bool(matched[0].get('VolumeOptions',{}).get('NoCopy')) is bool(mount.get('volume',{}).get('nocopy',False)), 'HOST_UPDATE_STORAGE_BINDING')

class HostUpdater:
    def __init__(self, prefix, config, *, uid=0, inspect=None, launcher=None, execute=None):
        self.prefix, self.config, self.uid = Path(prefix), config, uid
        self.state = self.prefix / 'state'
        self.inspect = inspect or self.inspect_current
        self.launcher = launcher or self.launch_service
        self.execute = execute or self.install
        self.env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8',
                    'DOCKER_HOST': 'unix:///var/run/docker.sock', 'DOCKER_CONFIG': str(self.state / 'docker-config')}
        for name in ['plans', 'operations', 'docker-config', 'jobs']:
            (self.state / name).mkdir(mode=0o700, exist_ok=True)
        descriptor = os.open(self.state, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(descriptor)
        finally: os.close(descriptor)

    def read_job(self, identifier):
        path = self.state / 'jobs' / (request_id(identifier) + '.json')
        try:
            value = read_json(path, self.uid)
            check(exact(value, 'schema,jobId,idempotencyKey,kind,target,state,reason,transitions,updatedAtNs')
                  and value['schema'] == 'bellteam.update-job.v1' and value['jobId'] == identifier
                  and value['state'] in JOB_STATES and value['kind'] in {'container', 'module', 'runtime'}
                  and type(value['idempotencyKey']) is str and re.fullmatch(r'[\x20-\x7e]{1,128}', value['idempotencyKey'])
                  and exact(value['target'], 'catalogSha256,moduleId,versionId')
                  and type(value['transitions']) is list and 1 <= len(value['transitions']) <= 6
                  and all(exact(row, 'state,atNs') and row['state'] in JOB_STATES
                          and type(row['atNs']) is str and row['atNs'].isdigit() for row in value['transitions'])
                  and value['transitions'][-1] == {'state': value['state'], 'atNs': value['updatedAtNs']}
                  and type(value['updatedAtNs']) is str and value['updatedAtNs'].isdigit()
                  and (exact(value['reason'], 'code,message') if value['state'] == 'failed' else value['reason'] is None),
                  'JOB_RECORD_INVALID')
            return value
        except FileNotFoundError:
            raise Failure('HOST_UPDATE_NOT_FOUND', 404)
        except (OSError, Failure, KeyError, TypeError) as error:
            raise Failure('UNREADABLE', path=str(path), reason=getattr(error, 'code', None) or type(error).__name__)

    def prune_jobs(self):
        terminal = []
        for path in (self.state / 'jobs').glob('*.json'):
            job = self.read_job(path.stem)
            if job['state'] in {'ready', 'failed'}: terminal.append(job)
        for job in sorted(terminal, key=lambda row: int(row['updatedAtNs']), reverse=True)[JOB_RETAIN:]:
            directory = self.state / 'operations' / job['jobId']
            if directory.exists():
                operation = self.read_operation(job['jobId'])
                if operation['phase'] not in TERMINAL: continue
                trusted(directory, self.uid, directory=True)
                shutil.rmtree(directory)
            (self.state / 'jobs' / (job['jobId'] + '.json')).unlink()
        descriptor = os.open(self.state / 'jobs', os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(descriptor)
        finally: os.close(descriptor)

    def admit_job(self, params):
        check(exact(params, 'jobId,idempotencyKey,kind,target'))
        identifier, target = request_id(params['jobId']), params['target']
        check(type(params['idempotencyKey']) is str and re.fullmatch(r'[\x20-\x7e]{1,128}', params['idempotencyKey'])
              and params['kind'] in {'container', 'module', 'runtime'} and exact(target, 'catalogSha256,moduleId,versionId')
              and target['moduleId'] in MODULES | RUNTIMES | {'container'}
              and job_kind(target['moduleId']) == params['kind']
              and (target['catalogSha256'] is None or digest(target['catalogSha256']))
              and type(target['versionId']) is str and (target['versionId'] == 'builtin'
                   or re.fullmatch('[a-f0-9]{64}|sha256:[a-f0-9]{64}', target['versionId'])))
        with locked(self.state / 'ledger.lock', wait=True):
            for path in (self.state / 'jobs').glob('*.json'):
                job = self.read_job(path.stem)
                if job['idempotencyKey'] == params['idempotencyKey'] or job['jobId'] == identifier:
                    check(job['target'] == target and job['kind'] == params['kind'] and job['idempotencyKey'] == params['idempotencyKey'],
                          'HOST_UPDATE_REQUEST_CONFLICT', 409)
                    return job
            at = str(time.time_ns())
            job = {'schema': 'bellteam.update-job.v1', **params, 'state': 'queued', 'reason': None,
                   'transitions': [{'state': 'queued', 'atNs': at}], 'updatedAtNs': at}
            atomic(self.state / 'jobs' / (identifier + '.json'), job)
            self.prune_jobs()
            return job

    def set_job(self, identifier, state, reason=None):
        # Caller holds ledger.lock; installation progress and parent activation share this writer.
        job = self.read_job(identifier)
        check(state in JOB_STATES)
        if job['state'] == state:
            check(job['reason'] == reason, 'HOST_UPDATE_JOB_CONFLICT', 409)
            return job
        check(job['state'] not in {'ready', 'failed'} and (state == 'failed'
              or JOB_STATES.index(state) == JOB_STATES.index(job['state']) + 1), 'HOST_UPDATE_JOB_CONFLICT', 409)
        check((exact(reason, 'code,message') and type(reason['code']) is str and re.fullmatch('[A-Z_0-9]{1,100}', reason['code'])
               and type(reason['message']) is str and 1 <= len(reason['message']) <= 256)
              if state == 'failed' else reason is None)
        at = str(time.time_ns())
        job.update(state=state, reason=reason, updatedAtNs=at)
        job['transitions'].append({'state': state, 'atNs': at})
        atomic(self.state / 'jobs' / (identifier + '.json'), job)
        if state in {'ready', 'failed'}: self.prune_jobs()
        return job

    def progress(self, directory, state):
        with locked(self.state / 'ledger.lock', wait=True):
            return self.set_job(directory.name, state)

    def job(self, identifier):
        with locked(self.state / 'ledger.lock', wait=True):
            job = self.read_job(identifier)
            if job['state'] not in {'ready', 'failed'} and (self.state / 'operations' / identifier / 'operation.json').exists():
                operation = self.read_operation(identifier)
                worker = operation.get('worker')
                lost = worker and operation['phase'] not in TERMINAL and not self.worker_alive(worker)
                unbound = not worker and time.time() - parse_time(operation['updatedAt']) > 30
                if lost and job['kind'] == 'runtime' and job['state'] == 'swapping' and self.runtime_committed(identifier):
                    # Commit already published and read back this job's generation: complete it, never re-select.
                    operation.update(phase='completed', execution='succeeded', verification='succeeded', error=None, updatedAt=stamp())
                    atomic(self.state / 'operations' / identifier / 'operation.json', operation)
                    return self.set_job(identifier, 'ready')
                if lost or unbound:
                    code = 'HOST_UPDATE_WORKER_LOST' if lost else 'HOST_UPDATE_HANDOFF_FAILED'
                    operation.update(phase='failed', execution='failed', verification='failed', error=code, updatedAt=stamp())
                    atomic(self.state / 'operations' / identifier / 'operation.json', operation)
                    job = self.set_job(identifier, 'failed', {'code': code, 'message': code})
            return job

    def runtime_committed(self, identifier):
        return False

    def jobs(self, limit=16):
        check(type(limit) is int and 1 <= limit <= 16)
        with locked(self.state / 'ledger.lock', wait=True):
            values = [self.read_job(path.stem) for path in (self.state / 'jobs').glob('*.json')]
        return {'jobs': [self.job(value['jobId']) for value in sorted(values, key=lambda row: int(row['updatedAtNs']), reverse=True)[:limit]]}

    def update_job(self, params):
        check(exact(params, 'jobId,state,reason') and params['state'] in JOB_STATES[1:])
        identifier = request_id(params['jobId'])
        with locked(self.state / 'ledger.lock', wait=True):
            job = self.read_job(identifier)
            operation_path = self.state / 'operations' / identifier / 'operation.json'
            if job['kind'] in {'container', 'runtime'}:  # parent may close only a step the worker never accepted
                check(job['state'] == 'queued' and params['state'] == 'failed'
                      and not os.path.lexists(operation_path) and not os.path.lexists(operation_path.parent / 'claimed'),
                      'HOST_UPDATE_JOB_CONFLICT', 409)
                return self.set_job(identifier, 'failed', params['reason'])
            check(job['kind'] == 'module', 'HOST_UPDATE_JOB_CONFLICT', 409)
            if operation_path.exists():
                operation = self.read_operation(identifier)
                check(params['state'] in {'swapping', 'ready', 'failed'} and operation['phase'] == 'completed'
                      and operation['execution'] == operation['verification'] == 'succeeded', 'HOST_UPDATE_JOB_NOT_INSTALLED', 409)
            return self.set_job(identifier, params['state'], params['reason'])

    @property
    def code_root(self):
        return self.prefix / 'releases' / self.config['release']

    def command(self, args, timeout=30, input=None):
        return subprocess.run(args, env=self.env, cwd='/', stdin=subprocess.DEVNULL if input is None else None,
                              input=input, capture_output=True, timeout=timeout, check=True).stdout

    def inspect_current(self):
        name = self.config['projectName']
        raw = self.command([self.config['docker'], 'ps', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + name,
                            '--filter', 'label=com.docker.compose.service=bellteam', '--format', '{{.ID}}']).decode().strip()
        check(re.fullmatch('[a-f0-9]{64}', raw), 'HOST_UPDATE_CURRENT_UNAVAILABLE')
        runtime = decode(self.command([self.config['docker'], 'container', 'inspect', '--format',
            '{"id":{{json .Id}},"image":{{json .Image}},"running":{{json .State.Running}},"restarting":{{json .State.Restarting}},"health":{{json .State.Health.Status}}}', raw]))
        check(runtime['running'] is True and runtime['restarting'] is False, 'HOST_UPDATE_CURRENT_UNAVAILABLE')
        distribution = decode(self.command([self.config['docker'], 'exec', '--user', '1001:1001', raw,
                                             '/bin/cat', '/app/distribution.json']))
        check(distribution.get('schema') == 'bellteam.server.distribution.v1'
              and re.fullmatch('[a-f0-9]{40}', distribution.get('sourceCommit', '')), 'HOST_UPDATE_CURRENT_UNAVAILABLE')
        refs = decode(self.command([self.config['docker'], 'image', 'inspect', '--format', '{{json .RepoDigests}}', runtime['image']]))
        refs = [ref for ref in refs or [] if re.fullmatch('ghcr.io/kitepon/bellteam-server@sha256:[a-f0-9]{64}', ref)]
        storage = self.storage_metadata(raw)
        binding = hashlib.sha256(json.dumps(storage,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        return {'storageBinding':binding, 'containerId': raw, 'imageId': runtime['image'], 'sourceCommit': distribution['sourceCommit'], 'health': runtime['health'],
                'imageRef': refs[0] if len(refs) == 1 else None}

    def storage_metadata(self, identifier):
        docker = self.config['docker']
        mounts = decode(self.command([docker,'container','inspect','--format','{{json .Mounts}}',identifier]))
        specs = decode(self.command([docker,'container','inspect','--format','{{json .HostConfig.Mounts}}',identifier]))
        check(type(mounts) is list and type(specs) is list, 'HOST_UPDATE_STORAGE_BINDING')
        return {'mounts':sorted(mounts,key=lambda row:row['Destination']), 'specs':sorted(specs,key=lambda row:row['Target'])}

    def assert_model_binding(self, current, normal=None):
        normal = normal or read_json(self.prefix / 'installation/normal.json', self.uid, CATALOG_LIMIT)
        storage = self.storage_metadata(current['containerId'])
        verify_model_mounts(normal, storage['mounts'], storage['specs'])

    def catalog(self, requested):
        pointer = read_json(self.prefix / 'catalog/state.json', self.uid, CATALOG_LIMIT)
        check(pointer.get('schema') == 'bellteam.update-catalog.state.v1', 'HOST_UPDATE_CATALOG_UNTRUSTED')
        check(pointer.get('catalogSha256') not in pointer.get('revokedCatalogs', []), 'HOST_UPDATE_CATALOG_REVOKED')
        check(time.time() + 300 >= parse_time(pointer['lastObservedAt']), 'HOST_UPDATE_CLOCK_UNCERTAIN')
        check(digest(pointer['catalogSha256']) == requested, 'HOST_UPDATE_CATALOG_CHANGED', 409)
        releases = self.prefix / 'catalog/releases'
        for other in releases.iterdir():
            if other.name != requested and re.fullmatch('[a-f0-9]{64}', other.name):
                metadata = read_json(other / 'installation.json', self.uid)
                check(parse_time(metadata['publishedAt']) <= parse_time(pointer['publishedAt']), 'HOST_UPDATE_CATALOG_COMMIT_INCOMPLETE')
        directory = releases / requested
        receipt = read_json(directory / 'installation.json', self.uid)
        check(receipt.get('schema') == 'bellteam.update-catalog.installation.v1'
              and receipt.get('catalogSha256') == requested
              and valid_catalog_verification(receipt.get('verification')),
              'HOST_UPDATE_CATALOG_UNTRUSTED')
        path = directory / 'catalog.json'
        trusted(path, self.uid)
        check(path.stat().st_size <= CATALOG_LIMIT, 'HOST_UPDATE_CATALOG_UNTRUSTED')
        raw = path.read_bytes()
        check(len(raw) <= CATALOG_LIMIT and hashlib.sha256(raw).hexdigest() == requested, 'HOST_UPDATE_CATALOG_UNTRUSTED')
        catalog = decode(raw)
        check(catalog.get('schema') == 'bellteam.update-catalog.v1' and type(catalog.get('releases')) is list,
              'HOST_UPDATE_CATALOG_UNTRUSTED')
        # Freshness and revocation fields are supplied by distribution's signed catalog contract.
        check(parse_time(catalog.get('publishedAt')) <= time.time() + 300
              and parse_time(catalog.get('expiresAt')) > time.time(), 'HOST_UPDATE_CATALOG_EXPIRED')
        return catalog

    def target(self, catalog_id, version):
        check(type(version) is str and re.fullmatch('sha256:[a-f0-9]{64}', version))
        platform = self.config['platform']
        found = [item for item in self.catalog(catalog_id)['releases']
                 if item.get('componentId') == 'container' and item.get('versionId') == version and item.get('platform') == platform]
        check(len(found) == 1, 'HOST_UPDATE_TARGET_UNAVAILABLE')
        value = found[0]
        check(exact(value, 'componentId,sourceCommit,versionId,platform,artifact,compatibility,changes')
              and re.fullmatch('[a-f0-9]{40}', value['sourceCommit'])
              and value['artifact'] == {'kind': 'oci-index', 'reference': 'ghcr.io/kitepon/bellteam-server@' + version}
              and value['compatibility'].get('containerUpdate') == 1, 'HOST_UPDATE_TARGET_INCOMPATIBLE')
        return value

    def module_target(self, catalog_id, component, version):
        check(type(component) is str and component in MODULES | RUNTIMES)
        # Elegg 2026-11-08: the body's lifetime Aiterm connection shares this scope, so aiterm-mcp updates only with the body image.
        check(component != 'runtime-aiterm-mcp', 'RUNTIME_COHABITATION_UNSUPPORTED', 409)
        digest(version)
        rows = self.catalog(catalog_id)['releases'] if component in MODULES else runtime_rows(self, catalog_id)
        found = [row for row in rows if row.get('componentId') == component
                 and row.get('versionId') == version and row.get('platform') == self.config['platform']]
        check(len(found) == 1, 'HOST_MODULE_TARGET_UNAVAILABLE')
        value = found[0]
        check(exact(value, 'componentId,sourceCommit,versionId,platform,artifact,compatibility,changes')
              and type(value['sourceCommit']) is str and re.fullmatch('[a-f0-9]{40}', value['sourceCommit']), 'HOST_MODULE_TARGET_INVALID')
        artifact = value['artifact']
        check(exact(artifact, 'kind,archive,bundle,signerCommit') and artifact['kind'] == 'archive'
              and type(artifact['signerCommit']) is str and re.fullmatch('[a-f0-9]{40}', artifact['signerCommit']), 'HOST_MODULE_TARGET_INVALID')
        for name, limit in [('archive', 512 * 1024**2), ('bundle', 16 * 1024**2)]:
            item = artifact[name]
            check(exact(item, 'url,sha256,bytes') and type(item['bytes']) is int and 0 < item['bytes'] <= limit
                  and type(item['sha256']) is str and re.fullmatch('[a-f0-9]{64}', item['sha256']), 'HOST_MODULE_TARGET_INVALID')
        url = r'https://github\.com/kitepon/BellTeam/releases/download/updates-\d{8}T\d{6}Z/' + component + '-' + value['sourceCommit'] + '-linux-' + self.config['platform']['arch'] + r'\.tar\.gz'
        check(type(artifact['archive']['url']) is str and re.fullmatch(url, artifact['archive']['url'])
              and artifact['archive']['sha256'] == version and artifact['bundle']['url'] == artifact['archive']['url'] + '.sigstore.json', 'HOST_MODULE_TARGET_INVALID')
        compatibility = value['compatibility']
        if component in RUNTIMES:
            check(compatibility == {'runtimeProtocol': 1, 'nodeMajor': 26, 'libc': 'glibc'}, 'HOST_MODULE_TARGET_INCOMPATIBLE')
            return value
        compound = component not in {'web-gateway', 'notifications'}
        check(exact(compatibility, 'nodeMajor,parentProtocol,stateSchema,containerUpdate' + (',stateCompatibility' if compound else ''))
              and type(compatibility['nodeMajor']) is int and compatibility['nodeMajor'] == 26
              and type(compatibility['parentProtocol']) is int and compatibility['parentProtocol'] == (2 if component == 'notifications' else 1)
              and compatibility['containerUpdate'] is None
              and (compound or type(compatibility['stateSchema']) is int)
              and compatibility['stateSchema'] == (None if compound else 2 if component == 'notifications' else 1), 'HOST_MODULE_TARGET_INCOMPATIBLE')
        return value

    def planned_target(self, plan):
        target = plan['target']
        return (self.target(plan['catalogSha256'], target['versionId']) if target['componentId'] == 'container'
                else self.module_target(plan['catalogSha256'], target['componentId'], target['versionId']))

    def plan(self, params):
        check(exact(params, 'planId,catalogSha256,versionId') or exact(params, 'planId,catalogSha256,componentId,versionId'))
        component = params.get('componentId', 'container')
        check(type(component) is str and component in MODULES | RUNTIMES | {'container'})
        identifier = request_id(params['planId']); catalog_id = digest(params['catalogSha256'])
        with locked(self.state / 'ledger.lock'):
            path = self.state / 'plans' / (identifier + '.json')
            if path.exists():
                value = read_json(path, self.uid)
                check(value['catalogSha256'] == catalog_id and value['target']['versionId'] == params['versionId']
                      and value['target']['componentId'] == component, 'HOST_UPDATE_PLAN_CONFLICT', 409)
                return value
            referenced = set()
            for name in POINTERS:
                pointer_path = self.state / name
                if pointer_path.exists():
                    for operation in read_json(pointer_path, self.uid).values():
                        if operation and (self.state / 'operations' / operation / 'operation.json').exists():
                            referenced.add(self.read_operation(operation)['planId'])
            # Unresolved (unknown) operations keep their plan: reconciliation and the termination bridge read it.
            for operation in (self.state / 'operations').iterdir():
                if (operation / 'operation.json').exists():
                    value = self.read_operation(operation.name)
                    if value['phase'] not in TERMINAL: referenced.add(value['planId'])
            for candidate in (self.state / 'plans').glob('*.json'):
                value = read_json(candidate, self.uid)
                if value['planId'] not in referenced and parse_time(value['expiresAt']) <= time.time(): candidate.unlink()
            check(len(list((self.state / 'plans').glob('*.json'))) < 64, 'HOST_UPDATE_PLAN_CAPACITY', 409)
            target = (self.target(catalog_id, params['versionId']) if component == 'container'
                      else self.module_target(catalog_id, component, params['versionId']))
            current = self.inspect()
            if component == 'container':
                check(target['artifact']['reference'] != current.get('imageRef'), 'HOST_UPDATE_ALREADY_CURRENT', 409)
            value = {'schema': 'bellteam.host-update.plan.v1', 'planId': identifier, 'catalogSha256': catalog_id,
                     'target': target, 'expected': current, 'expiresAt': dt.datetime.fromtimestamp(time.time() + 300, dt.timezone.utc).isoformat(),
                     'impact': {'containerRestart': component == 'container'}}
            atomic(path, value)
            return value

    def read_operation(self, identifier):
        request_id(identifier)
        path = self.state / 'operations' / identifier / 'operation.json'
        if not path.exists():
            raise Failure('HOST_UPDATE_NOT_FOUND', 404)
        try: return read_json(path, self.uid)
        except (OSError, Failure) as error:
            raise Failure('UNREADABLE', path=str(path), reason=getattr(error, 'code', None) or type(error).__name__)

    def view(self, value):
        result = {key: value[key] for key in ['requestId', 'planId', 'target', 'admission', 'phase', 'execution',
            'verification', 'error', 'cleanup', 'rollback', 'observed', 'updatedAt']}
        job = self.read_job(value['requestId'])
        result.update(jobId=job['jobId'], state=job['state'], reason=job['reason'], job=job)
        return result

    def get(self, identifier):
        self.job(identifier)
        with locked(self.state / 'ledger.lock', wait=True):
            return self.view(self.read_operation(identifier))

    def worker_alive(self, worker):
        return birth(worker['pid']) == worker['birth']

    def operation_pending(self, identifier):
        path = self.state / 'jobs' / (identifier + '.json')
        if path.exists(): return self.read_job(identifier)['state'] not in {'ready', 'failed'}
        directory = self.state / 'operations' / identifier / 'operation.json'
        return directory.exists() and self.read_operation(identifier)['phase'] not in TERMINAL

    def worker_identity(self, identifier):
        return {'pid': os.getpid(), 'birth': birth(os.getpid()),
                'unit': 'bellteam-container-update-worker-' + identifier + '.service'}

    def start(self, params):
        check(exact(params, 'requestId,planId,confirmContainerRestart') or exact(params, 'requestId,planId,confirmContainerRestart,idempotencyKey'))
        identifier, plan_id = request_id(params['requestId']), request_id(params['planId'])
        key = params.get('idempotencyKey', identifier)
        check(type(key) is str and re.fullmatch(r'[\x20-\x7e]{1,128}', key) and type(params['confirmContainerRestart']) is bool)
        with locked(self.state / 'ledger.lock', wait=True):
            admitted = None
            for path in (self.state / 'jobs').glob('*.json'):
                job = self.read_job(path.stem)
                if job['idempotencyKey'] == key or job['jobId'] == identifier:
                    check(job['idempotencyKey'] == key, 'HOST_UPDATE_REQUEST_CONFLICT', 409)
                    identifier = job['jobId']
                    if not (self.state / 'operations' / identifier / 'operation.json').exists():
                        check(job['state'] == 'queued', 'HOST_UPDATE_JOB_CONFLICT', 409)
                        admitted = job
                        break
                    existing = self.read_operation(job['jobId'])
                    check(existing['planId'] == plan_id and job['idempotencyKey'] == key, 'HOST_UPDATE_REQUEST_CONFLICT', 409)
                    return self.view(existing)
            directory = self.state / 'operations' / identifier
            check(not directory.exists(), 'HOST_UPDATE_REQUEST_CONFLICT', 409)
            plan = read_json(self.state / 'plans' / (plan_id + '.json'), self.uid)
            target = {'catalogSha256': plan['catalogSha256'], 'moduleId': plan['target']['componentId'], 'versionId': plan['target']['versionId']}
            if admitted: check(admitted['target'] == target, 'HOST_UPDATE_REQUEST_CONFLICT', 409)
            check(params['confirmContainerRestart'] == plan['impact']['containerRestart'], 'HOST_UPDATE_RESTART_CONFIRMATION_REQUIRED', 409)
            check(parse_time(plan['expiresAt']) > time.time(), 'HOST_UPDATE_PLAN_EXPIRED', 409)
            check(self.planned_target(plan) == plan['target'], 'HOST_UPDATE_PLAN_CHANGED', 409)
            check(self.inspect() == plan['expected'], 'HOST_UPDATE_CURRENT_CHANGED', 409)
            pointer_path = self.state / {'container': 'current.json', 'module': 'module-current.json', 'runtime': 'runtime-current.json'}[job_kind(plan['target']['componentId'])]
            pointer = read_json(pointer_path, self.uid) if pointer_path.exists() else {'current': None, 'previous': None}
            for name in POINTERS:
                path = self.state / name
                active = read_json(path, self.uid) if path.exists() else {'current': None}
                if active['current']:
                    check(not self.operation_pending(active['current']), 'HOST_UPDATE_IN_PROGRESS', 409)
            directory.mkdir(mode=0o700)
            value = {'schema': 'bellteam.host-update.operation.v1', 'requestId': identifier, 'planId': plan_id,
                     'target': plan['target'], 'admission': 'accepted', 'phase': 'preparing', 'execution': 'pending',
                     'verification': 'pending', 'cleanup': 'pending', 'rollback': 'not_needed', 'observed': None,
                     'error': None, 'worker': None, 'updatedAt': stamp()}
            atomic(directory / 'operation.json', value)
            descriptor = os.open(directory.parent, os.O_RDONLY | os.O_DIRECTORY)
            try: os.fsync(descriptor)
            finally: os.close(descriptor)
            at = str(time.time_ns())
            job = {'schema': 'bellteam.update-job.v1', 'jobId': identifier, 'idempotencyKey': key,
                   'kind': job_kind(plan['target']['componentId']),
                   'target': {'catalogSha256': plan['catalogSha256'], 'moduleId': plan['target']['componentId'], 'versionId': plan['target']['versionId']},
                   'state': 'queued', 'reason': None, 'transitions': [{'state': 'queued', 'atNs': at}], 'updatedAtNs': at}
            if not admitted: atomic(self.state / 'jobs' / (identifier + '.json'), job)
            atomic(pointer_path, {'current': identifier, 'previous': pointer['current']})
            self.prune_jobs()
        # Acceptance is durable before launch; a repeated key only reads this record.
        try:
            self.launcher(identifier)
        except Exception:
            with locked(self.state / 'ledger.lock', wait=True):
                value = self.read_operation(identifier)
                if value['worker'] is None and self.read_job(identifier)['state'] == 'queued':
                    code = 'HOST_UPDATE_HANDOFF_FAILED'
                    value.update(phase='failed', execution='failed', verification='failed', error=code, updatedAt=stamp())
                    atomic(directory / 'operation.json', value)
                    self.set_job(identifier, 'failed', {'code': code, 'message': code})
        return self.get(identifier)

    def launch_service(self, identifier):
        identifier = request_id(identifier)
        release = self.prefix / 'releases' / self.config['release']
        entry = release / 'scripts/container-update-host.py'
        trusted(entry, self.uid)
        unit = 'bellteam-container-update-worker-' + identifier
        command = [self.config['systemdRun'], '--system', '--quiet', '--collect', '--unit=' + unit,
                   '--property=Type=exec', '--property=Restart=no', '--property=KillMode=control-group',
                   '--property=UMask=0077', '--property=StandardInput=null',
                   '--property=StandardOutput=append:' + str(self.state / 'operations' / identifier / 'worker.log'),
                   '--property=StandardError=append:' + str(self.state / 'operations' / identifier / 'worker.log'),
                   '--property=WorkingDirectory=/', '--property=NoNewPrivileges=yes', '--property=ProtectSystem=strict',
                   '--property=PrivateTmp=yes', '--property=PrivateDevices=yes', '--property=ProtectKernelTunables=yes',
                   '--property=ProtectKernelModules=yes', '--property=ProtectControlGroups=yes',
                   '--property=CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER',
                   '--property=ReadWritePaths=' + ' '.join([str(self.state), str(self.prefix / 'installation'), self.config['installRoot'], *self.config['writePaths']]),
                   self.config['python'], '-I', '-B', '-S', str(entry), '--worker', identifier]
        self.command(command, timeout=5)

    def worker(self, identifier):
        identifier = request_id(identifier)
        directory = self.state / 'operations' / identifier
        with locked(self.state / 'worker.lock'):
            marker = directory / 'claimed'
            fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
            with locked(self.state / 'ledger.lock', wait=True):
                value = self.read_operation(identifier)
                check(value['admission'] == 'accepted' and value['worker'] is None and self.read_job(identifier)['state'] == 'queued', 'HOST_UPDATE_WORKER_DUPLICATE')
                try:
                    plan = read_json(self.state / 'plans' / (value['planId'] + '.json'), self.uid)
                    check(self.planned_target(plan) == plan['target'], 'HOST_UPDATE_PLAN_CHANGED')
                    check(parse_time(plan['expiresAt']) > time.time(), 'HOST_UPDATE_PLAN_EXPIRED')
                    observed = self.inspect()
                    check(observed == plan['expected'], 'HOST_UPDATE_CURRENT_CHANGED')
                    self.assert_model_binding(observed)
                    if plan['target']['componentId'] in MODULES:
                        atomic(directory / 'module-volume.json', self.module_volume(observed, directory))
                    check(birth(os.getpid()) is not None, 'HOST_UPDATE_WORKER_IDENTITY')
                except Failure as error:
                    value.update(admission='rejected', phase='failed', execution='failed', verification='failed', error=error.code, updatedAt=stamp())
                    atomic(directory / 'operation.json', value)
                    self.set_job(identifier, 'failed', {'code': error.code, 'message': error.code})
                    return
                value.update(admission='accepted', worker=self.worker_identity(identifier), updatedAt=stamp())
                atomic(directory / 'operation.json', value)
            try:
                self.progress(directory, 'downloading')
                # Every operation.json replace happens under ledger.lock, so a locked reader never sees the rename mid-read.
                with locked(self.state / 'ledger.lock', wait=True):
                    value.update(phase='applying', updatedAt=stamp()); atomic(directory / 'operation.json', value)
                outcome = self.execute(plan, directory)
                value.update(outcome)
                value['phase'] = 'completed' if value['execution'] == value['verification'] == 'succeeded' else 'failed'
            except Exception as error:
                code = error.code if isinstance(error, Failure) else 'HOST_UPDATE_EXECUTION_FAILED'
                value.update(phase='failed', execution='failed', verification='failed', error=code)
            value['updatedAt'] = stamp()
            with locked(self.state / 'ledger.lock', wait=True):
                if self.read_job(identifier)['state'] == 'failed': return
                atomic(directory / 'operation.json', value)
                if value['phase'] == 'failed':
                    code = value['error'] or 'HOST_UPDATE_EXECUTION_FAILED'
                    self.set_job(identifier, 'failed', {'code': code, 'message': code})
                elif job_kind(plan['target']['componentId']) in {'container', 'runtime'}:
                    # Runtime selection is committed and read back by install(); there is no parent activation step.
                    self.set_job(identifier, 'ready')

    def capabilities(self):
        references = read_json(self.state / 'current.json', self.uid) if (self.state / 'current.json').exists() else {'current': None, 'previous': None}
        result = {'supported': False, 'reason': 'HOST_UPDATE_CATALOG_UNAVAILABLE',
                  'currentRequestId': references['current'], 'previousRequestId': references['previous'], 'moduleInstallProtocol': 1}
        try:
            pointer = read_json(self.prefix / 'catalog/state.json', self.uid, CATALOG_LIMIT)
            self.catalog(pointer['catalogSha256'])
            result.update(supported=True, reason=None)
        except Failure as error:
            result['reason'] = error.code
        except (OSError, KeyError):
            pass
        return result

    def dispatch(self, frame):
        check(exact(frame, 'operation,params') and type(frame['params']) is dict)
        action, params = frame['operation'], frame['params']
        if action == 'capabilities':
            check(params == {}); return self.capabilities()
        if action == 'catalog':
            check(exact(params, 'componentId') and type(params['componentId']) is str
                  and params['componentId'] in MODULES | RUNTIMES | {'container'})
            pointer = read_json(self.prefix / 'catalog/state.json', self.uid, CATALOG_LIMIT)
            catalog = self.catalog(pointer['catalogSha256'])
            rows = runtime_rows(self, pointer['catalogSha256']) if params['componentId'] in RUNTIMES else catalog['releases']
            selected = [row for row in rows if row['componentId'] == params['componentId'] and row['platform'] == self.config['platform']]
            check(len(selected) <= 1, 'HOST_UPDATE_CATALOG_UNTRUSTED')
            return {'schema':'bellteam.update-catalog.selection.v1','catalogSha256':pointer['catalogSha256'],
                    'publishedAt':catalog['publishedAt'],'expiresAt':catalog['expiresAt'],'release':selected[0] if selected else None,
                    'publication':read_json(self.prefix/'catalog/refresh.json',self.uid) if (self.prefix/'catalog/refresh.json').exists() else {'status':'unconfirmed','checkedAt':None,'error':'HOST_UPDATE_PUBLICATION_UNCONFIRMED'}}
        if action == 'checkCatalog':
            check(params == {})
            try: refresh_catalog(self)
            except Exception: pass # A failed check is a normal fact: refresh.json already holds status 'failed'.
            return read_json(self.prefix/'catalog/refresh.json', self.uid)
        if action == 'plan': return self.plan(params)
        if action == 'start': return self.start(params)
        if action == 'admitJob': return self.admit_job(params)
        if action == 'getJob':
            check(exact(params, 'jobId')); return self.job(params['jobId'])
        if action == 'listJobs':
            check(exact(params, 'limit')); return self.jobs(params['limit'])
        if action == 'updateJob': return self.update_job(params)
        if action == 'get':
            check(exact(params, 'requestId')); return self.get(params['requestId'])
        raise Failure('HOST_UPDATE_ARGUMENTS', 400)

    def install(self, plan, directory):
        # Runtime updates exist only in the bundled module-installer (module-update-service.py).
        check(plan['target']['componentId'] not in RUNTIMES, 'HOST_RUNTIME_UPDATE_UNSUPPORTED')
        return (execute_installer(self, plan, directory) if plan['target']['componentId'] == 'container'
                else execute_module_installer(self, plan, directory))

    def module_volume(self, current, directory):
        normal = read_json(self.prefix / 'installation/normal.json', self.uid, CATALOG_LIMIT)
        service = normal['services']['bellteam']
        # The validation helper receives mount metadata, never the normal server environment.
        model = {'name': self.config['projectName'], 'services': {'bellteam': {
            'image': current['imageId'], 'volumes': service['volumes'],
            'environment': {key: value for key, value in service.get('environment', {}).items() if key == 'AITERM_STATE_BASE'}}},
            'volumes': {key: {field: value for field, value in definition.items() if field in {'name', 'external'}}
                        for key, definition in normal.get('volumes', {}).items()}}
        if 'state-maintenance' in normal['services']:
            model['services']['state-maintenance'] = {'volumes': normal['services']['state-maintenance']['volumes']}
        runtime = decode(self.command([self.config['docker'], 'container', 'inspect', '--format',
            '{"id":{{json .Id}},"image":{{json .Image}},"running":{{json .State.Running}},"restarting":{{json .State.Restarting}},"readOnly":{{json .HostConfig.ReadonlyRootfs}},"project":{{json (index .Config.Labels "com.docker.compose.project")}}}', current['containerId']]))
        storage = self.storage_metadata(current['containerId'])
        runtime.update(mounts=storage['mounts'], specMounts=storage['specs'])
        check(runtime['id'] == current['containerId'] and runtime['image'] == current['imageId'], 'HOST_UPDATE_CURRENT_CHANGED')
        target = read_json(directory / 'operation.json', self.uid)['target']
        program = """import {webGatewayInstallPlan} from '/app/src/web-gateway-install-plan.mjs';import {text} from 'node:stream/consumers';import {lstat} from 'node:fs/promises';
const [normal,current,target]=JSON.parse(await text(process.stdin)),id=target.componentId;
if(Number(process.versions.node.split('.')[0])!==26||target.platform.os!==process.platform||target.platform.arch!==({x64:'amd64',arm64:'arm64'})[process.arch])throw Error('platform');
if(!(await lstat('/app/scripts/install-'+id+'-release.py')).isFile())throw Error('installer');
const validators={members:['/app/src/members/state-compatibility.mjs','assertMembersStateCompatibility'],memory:['/app/src/memory/state-compatibility.mjs','assertMemoryStateCompatibility'],conversation:['/app/src/conversation/state-compatibility.mjs','assertConversationStateCompatibility'],usage:['/app/src/usage/state-compatibility.mjs','assertUsageStateCompatibility'],diagnostics:['/app/src/diagnostics-protocol.mjs','assertDiagnosticsStateCompatibility'],'work-graph':['/app/src/work-graph-protocol.mjs','assertWorkGraphStateCompatibility']};
if(Object.hasOwn(validators,id)){const [path,name]=validators[id];(await import(path))[name](target.compatibility.stateCompatibility)}
if(id==='execution'&&(await import('/app/src/execution-dispatcher.mjs')).EXECUTION_STATE_COMPATIBILITY!==target.compatibility.stateCompatibility)throw Error('compatibility');
const plan=webGatewayInstallPlan(normal,current,id);console.log(JSON.stringify({privateVolume:plan.volumes['server-state'].name}));"""
        try:
            output = self.command([self.config['docker'], 'run', '--rm', '--interactive', '--network', 'none', '--read-only', '--user', '1001:1001',
                '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '64', '--memory', '256m',
                '--memory-swap', '256m', '--entrypoint', '/usr/local/bin/node', current['imageId'], '--input-type=module', '-e', program],
                input=json.dumps([model, runtime, target]).encode())
        except (OSError, subprocess.SubprocessError):
            raise Failure('HOST_MODULE_INSTALL_UNAVAILABLE')
        result = decode(output)
        controls = [mount for mount in storage['mounts'] if mount.get('Destination') == '/run/bellteam-maintenance']
        check(exact(result, 'privateVolume') and type(result['privateVolume']) is str
              and re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_.-]*', result['privateVolume'])
              and len(controls) == 1 and controls[0].get('Type') == 'volume' and controls[0].get('RW') is False
              and controls[0].get('Name') == result['privateVolume'], 'HOST_MODULE_STORAGE_BINDING')
        return result


def publication_opener():
    import urllib.request
    from urllib.parse import urlsplit
    class Redirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, message, headers, url):
            parsed = urlsplit(url)
            check(parsed.scheme == 'https' and parsed.hostname in {'github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'}
                  and parsed.port in {None, 443} and parsed.username is None, 'HOST_UPDATE_PUBLICATION_REDIRECT')
            return super().redirect_request(request, fp, code, message, headers, url)
    return urllib.request.build_opener(Redirect())


def module_inputs(updater, target):
    import urllib.request
    base = updater.state / 'module-incoming'
    base.mkdir(mode=0o700, exist_ok=True); trusted(base, updater.uid, directory=True)
    base = base / target['componentId']
    base.mkdir(mode=0o700, exist_ok=True); trusted(base, updater.uid, directory=True)
    directory = base / target['versionId']
    def matches(path, expected):
        info = trusted(path, updater.uid)
        check(info.st_size == expected['bytes'], 'HOST_MODULE_INPUT_CHANGED')
        digest_value = hashlib.sha256()
        with path.open('rb') as stream:
            while block := stream.read(1024 * 1024): digest_value.update(block)
        check(digest_value.hexdigest() == expected['sha256'], 'HOST_MODULE_INPUT_CHANGED')
    if directory.exists():
        trusted(directory, updater.uid, directory=True)
        check({path.name for path in directory.iterdir()} == {'archive.tar.gz', 'bundle.json'}, 'HOST_MODULE_INPUT_CHANGED')
        for name, key in [('archive.tar.gz', 'archive'), ('bundle.json', 'bundle')]: matches(directory / name, target['artifact'][key])
        return directory
    # shortcut: retain at most four failed input sets per module; resolve their operations before adding more.
    check(len(list(base.iterdir())) < 4, 'HOST_MODULE_INPUT_CAPACITY', 409)
    with tempfile.TemporaryDirectory(prefix='.download-', dir=base) as staging:
        staging = Path(staging)
        opener, deadline = publication_opener(), time.monotonic() + 300
        for name, key in [('archive.tar.gz', 'archive'), ('bundle.json', 'bundle')]:
            expected = target['artifact'][key]
            with opener.open(urllib.request.Request(expected['url'], headers={'User-Agent': 'BellTeam-Updater'}), timeout=15) as response:
                check(response.status == 200, 'HOST_MODULE_INPUT_UNAVAILABLE')
                fd = os.open(staging / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
                with os.fdopen(fd, 'wb') as output:
                    total = 0
                    while block := response.read(1024 * 1024):
                        total += len(block)
                        check(total <= expected['bytes'] and time.monotonic() < deadline, 'HOST_MODULE_INPUT_LIMIT')
                        output.write(block)
                    output.flush(); os.fsync(output.fileno())
            matches(staging / name, expected)
        fd = os.open(staging, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(fd)
        finally: os.close(fd)
        publish_directory(staging, directory)
        fd = os.open(base, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
    return directory


def execute_module_installer(updater, plan, directory):
    target, current = plan['target'], plan['expected']
    try:
        incoming = module_inputs(updater, target)
        updater.progress(directory, 'verifying')
        check(updater.planned_target(plan) == target, 'HOST_UPDATE_PLAN_CHANGED')
        check(updater.inspect() == current, 'HOST_UPDATE_CURRENT_CHANGED')
    except Exception:
        return {'execution': 'failed', 'verification': 'failed', 'cleanup': 'not_needed', 'rollback': 'not_needed',
                'observed': None, 'error': 'HOST_MODULE_PREPARE_FAILED'}
    volume = read_json(directory / 'module-volume.json', updater.uid)['privateVolume']
    check(type(volume) is str and re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_.-]*', volume), 'HOST_MODULE_STORAGE_BINDING')
    component = target['componentId']
    check(component in MODULES, 'HOST_MODULE_TARGET_INVALID')
    # Construct privileges and mounts here; never execute a model supplied by the application or image helper.
    try: output = updater.command([updater.config['docker'], 'run', '--rm', '--init', '--network', 'none', '--read-only', '--user', '0:0',
        '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER',
        '--security-opt', 'no-new-privileges:true', '--cpus', '1', '--memory', '2g', '--memory-swap', '2g', '--pids-limit', '512',
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
        '--mount', f'type=bind,source={incoming.parent},target=/srv/bellteam-{component}-incoming,readonly',
        '--mount', f'type=volume,source={volume},target=/srv/bellteam-private,volume-nocopy',
        '--entrypoint', '/usr/bin/env', current['imageId'], '-i', 'PATH=/usr/local/bin:/usr/bin:/bin',
        '/usr/bin/python3', '-I', f'/app/scripts/install-{component}-release.py',
        target['versionId'], target['sourceCommit'], target['artifact']['signerCommit']], timeout=300)
    except subprocess.CalledProcessError as error:
        # The installer's last stderr line is its fixed failure code (e.g. USAGE_INSTALL_FAILED); keep it instead of a generic one.
        lines = (error.stderr or b'').decode(errors='replace').strip().splitlines()
        code = lines[-1] if lines and re.fullmatch('[A-Z][A-Z0-9_]{0,63}', lines[-1]) else 'HOST_MODULE_INSTALL_FAILED'
        raise Failure(code) from error
    result = decode(output)
    check(exact(result, 'versionId,installed') and result['versionId'] == target['versionId'] and result['installed'] is True,
          'HOST_MODULE_INSTALL_FAILED')
    observed = updater.inspect()
    check(observed == current, 'HOST_UPDATE_CURRENT_CHANGED')
    cleanup, error = 'succeeded', None
    try: shutil.rmtree(incoming)
    except OSError: cleanup, error = 'failed', 'HOST_MODULE_CLEANUP_FAILED'
    return {'execution': 'succeeded', 'verification': 'succeeded', 'cleanup': cleanup, 'rollback': 'not_needed',
            'observed': observed, 'error': error}

class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.request.settimeout(5)
        http = False
        try:
            _pid, uid, _gid = struct.unpack('3i', self.request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            check(uid == 1001, 'HOST_UPDATE_PEER_REJECTED', 403)
            raw = self.rfile.readline(LIMIT + 1)
            check(raw.endswith(b'\n') and len(raw) <= LIMIT, 'HOST_UPDATE_FRAME_INVALID', 400)
            http = raw.startswith(b'GET ')
            if http:
                match = re.fullmatch(rb'GET (/jobs(?:/[a-f0-9-]{36})?) HTTP/1\.[01]\r\n', raw)
                check(match is not None, 'HOST_UPDATE_ARGUMENTS', 400)
                total = len(raw)
                while True:
                    header = self.rfile.readline(LIMIT + 1); total += len(header)
                    check(header.endswith(b'\r\n') and total <= LIMIT, 'HOST_UPDATE_FRAME_INVALID', 400)
                    if header == b'\r\n': break
                path = match[1].decode()
                value = self.server.updater.jobs() if path == '/jobs' else self.server.updater.job(path.rsplit('/', 1)[1])
            else:
                value = self.server.updater.dispatch(decode(raw))
            result = {'ok': True, 'value': value}
        except Failure as error:
            result = {'ok': False, 'error': {'code': error.code, 'status': error.status, 'outcome': error.outcome}}
            if error.code == 'UNREADABLE': result['error'].update(path=error.path, reason=error.reason)
        except Exception as error:
            print(json.dumps({'code': 'HOST_UPDATE_REQUEST_FAILED', 'exception': type(error).__name__}), file=sys.stderr, flush=True)
            result = {'ok': False, 'error': {'code': 'UNREADABLE', 'status': 503, 'outcome': 'not_accepted',
                                          'path': str(self.server.updater.state), 'reason': type(error).__name__}}
        raw = (json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
        if len(raw) > LIMIT:
            result = {'ok': False, 'error': {'code': 'UNREADABLE', 'status': 503, 'outcome': 'not_accepted',
                                          'path': str(self.server.updater.state), 'reason': 'RESPONSE_LIMIT'}}
            raw = (json.dumps(result) + '\n').encode()
        try:
            if http:
                status = 200 if result['ok'] else result['error']['status']
                body = (json.dumps(result['value'] if result['ok'] else result) + '\n').encode()
                self.wfile.write(f'HTTP/1.1 {status} Result\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n'.encode() + body)
            else: self.wfile.write(raw)
        except OSError: pass

class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    request_queue_size = 16
    def __init__(self, address, updater):
        self.updater, self.slots = updater, threading.BoundedSemaphore(16)
        super().__init__(address, Handler)
    def process_request(self, request, client_address):
        # Bound active handlers without discarding a connected request during catalog fan-out.
        self.slots.acquire()
        try: super().process_request(request, client_address)
        except BaseException:
            self.slots.release(); raise
    def process_request_thread(self, request, client_address):
        try: super().process_request_thread(request, client_address)
        finally: self.slots.release()

def body_preflight(updater, ref, normal, directory):
    """Run the target image's own read-only preflight; only its definite 'fail' blocks the swap (Trony 2026-11-09)."""
    docker = updater.config['docker']
    try:
        project, state = updater.config['projectName'], normal['volumes']['server-state']['name']
        data = [m['source'] for m in normal['services']['bellteam']['volumes'] if m.get('type') == 'bind' and m.get('target') == '/srv/bellteam']
        check(len(data) == 1 and re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_.-]*', state) is not None, 'HOST_UPDATE_PREFLIGHT_UNKNOWN')
        for name in [project + '-module-updater', state]:  # inspect first so docker run never creates a volume
            updater.command([docker, 'volume', 'inspect', name])
        output = updater.command([docker, 'run', '--rm', '--interactive', '--network', 'none', '--read-only', '--user', '0:0',
            # Read-only search/read of the 1001- and root-owned 0600 records; every mount is read-only.
            '--cap-drop', 'ALL', '--cap-add', 'DAC_READ_SEARCH', '--security-opt', 'no-new-privileges:true', '--pids-limit', '64', '--memory', '512m',
            '--mount', 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock,readonly',
            '--mount', f'type=volume,source={project}-module-updater,target=/srv/bellteam-module-updater,readonly',
            '--mount', f'type=volume,source={state},target=/srv/bellteam-private,readonly',
            '--mount', f'type=volume,source={state},target=/run/bellteam-maintenance,readonly',
            '--mount', f'type=bind,source={data[0]},target=/srv/bellteam,readonly',
            '--entrypoint', '/usr/local/bin/node', ref, '/app/scripts/body-preflight.mjs'],
            timeout=120, input=json.dumps(normal).encode())
        result = decode(output)
        check(type(result) is dict and result.get('result') in ('pass', 'fail'), 'HOST_UPDATE_PREFLIGHT_UNKNOWN')
    except Exception:
        return 'unknown'  # cannot run or answer (older target, timeout): the swap proceeds as before
    try: atomic(directory / 'preflight.json', result)
    except Exception: pass
    return result['result']


def execute_installer(updater, plan, directory):
    config = updater.config
    release = updater.code_root
    install_root = Path(config['installRoot'])
    trusted(install_root, updater.uid, directory=True)
    script = release / 'install.sh'
    trusted(script, updater.uid)
    normal = read_json(updater.prefix / 'installation/normal.json', updater.uid, CATALOG_LIMIT)
    check(normal.get('name') == config['projectName'] and type(normal.get('services')) is dict
          and 'bellteam' in normal['services'], 'HOST_UPDATE_MODEL_INVALID')
    target = plan['target']
    ref = target['artifact']['reference']
    updater.command([config['docker'], 'pull', ref], timeout=900)
    updater.progress(directory, 'verifying')
    selected = updater.command([config['docker'], 'image', 'inspect', '--format', '{{.Id}}', ref]).decode().strip()
    check(re.fullmatch('sha256:[a-f0-9]{64}', selected), 'HOST_UPDATE_IMAGE_INVALID')
    check(updater.inspect_current() == plan['expected'], 'HOST_UPDATE_CURRENT_CHANGED')
    if body_preflight(updater, ref, normal, directory) == 'fail':
        return {'execution': 'failed', 'verification': 'failed', 'observed': None, 'cleanup': 'not_needed',
                'rollback': 'not_needed', 'error': 'HOST_UPDATE_PREFLIGHT_FAILED'}
    # The preflight can take up to 120 s; a body that changed meanwhile must not get a stale plan.
    check(updater.inspect_current() == plan['expected'], 'HOST_UPDATE_CURRENT_CHANGED')
    # Configuration remains in the existing private installation domain, never in the public ledger.
    inputs = updater.prefix / 'installation/operations' / plan['planId']
    inputs.mkdir(mode=0o700, parents=True, exist_ok=True)
    previous_normal = json.loads(json.dumps(normal))
    previous_normal['services']['bellteam']['image'] = plan['expected']['imageId']
    atomic(inputs / 'previous-normal.json', previous_normal, CATALOG_LIMIT)
    atomic(inputs / 'previous-runtime.json', {'Id': plan['expected']['containerId'], 'Image': plan['expected']['imageId']})
    normal['services']['bellteam']['image'] = ref
    normal_file = inputs / 'input-normal.json'; atomic(normal_file, normal, CATALOG_LIMIT)
    env = {**updater.env, 'COMPOSE_FILE': str(normal_file), 'COMPOSE_PROJECT_NAME': config['projectName'],
           'COMPOSE_DISABLE_ENV_FILE': 'true', 'BELLTEAM_INSTALL_DIR': str(install_root), 'BELLTEAM_SERVER_IMAGE': ref,
           'BELLTEAM_PREVIOUS_COMPOSE': str(inputs / 'previous-normal.json')}
    # No caller environment, writable checkout scripts, or user Docker/Node configuration enters this process.
    for path in [install_root / '.env']:
        if path.exists(): trusted(path, updater.uid)
    saved, state_failed = None, False
    def run(recover=False):
        nonlocal saved, state_failed
        args = [config['shell'], str(script)] + (['--recover', str(saved)] if recover else ['--no-pull'])
        with (directory / ('recover.log' if recover else 'installer.log')).open('wb') as log:
            child = subprocess.Popen(args, cwd=install_root, env=env, stdin=subprocess.DEVNULL,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, close_fds=True, start_new_session=True)
            deadline, recorded = time.monotonic() + 1800, 0
            try:
                selector = selectors.DefaultSelector(); selector.register(child.stdout, selectors.EVENT_READ)
                partial = b''
                while True:
                    check(time.monotonic() < deadline, 'HOST_UPDATE_INSTALL_TIMEOUT')
                    if selector.select(1):
                        block = os.read(child.stdout.fileno(), 65536)
                        if not block: break
                        if recorded < 8 * 1024 * 1024:
                            log.write(block[:8 * 1024 * 1024 - recorded]); recorded += len(block)
                        partial += block
                        check(len(partial) <= 2 * LIMIT, 'HOST_UPDATE_INSTALL_OUTPUT_LIMIT')
                        while b'\n' in partial:
                            line, partial = partial.split(b'\n', 1)
                            state_failed = state_failed or line == b'aiterm-state-apply=failed'
                            if line.startswith(b'saved-compose='):
                                candidate = Path(os.fsdecode(line[len(b'saved-compose='):]))
                                check(candidate.parent == install_root and re.fullmatch(r'\.bellteam-compose\.[A-Za-z0-9]{6}', candidate.name), 'HOST_UPDATE_GENERATION_INVALID')
                                trusted(candidate, updater.uid, directory=True)
                                saved = candidate
                    elif child.poll() is not None:
                        continue
                log.flush(); os.fchmod(log.fileno(), 0o600); os.fsync(log.fileno())
                return child.wait(timeout=5)
            finally:
                selector.close()
                child.stdout.close()
                if child.poll() is None:
                    # Persist the timeout as failure; terminate only this installer process group.
                    import signal
                    os.killpg(child.pid, signal.SIGKILL); child.wait()
    def verify():
        actual = updater.inspect_current()
        confirmed = actual['imageId'] == selected and actual['sourceCommit'] == target['sourceCommit'] and actual['health'] == 'healthy'
        if confirmed:
            check(saved is not None, 'HOST_UPDATE_GENERATION_FAILED')
            updater.assert_model_binding(actual, read_json(saved/'normal.json',updater.uid,CATALOG_LIMIT))
            actual['imageRef'] = ref
        return actual, confirmed
    updater.progress(directory, 'swapping')
    code = run()
    actual, confirmed = (None, False)
    if code == 0:
        try:
            actual, confirmed = verify()
        except (Failure, subprocess.SubprocessError):
            pass
    if code or not confirmed:
        rollback = 'unavailable'
        if saved and (saved / 'previous-normal.json').exists():
            try:
                recovered = run(True) == 0
                restored = updater.inspect_current()
                rollback = 'succeeded' if recovered and restored['imageId'] == plan['expected']['imageId'] and restored['sourceCommit'] == plan['expected']['sourceCommit'] and restored['health'] == 'healthy' else 'failed'
                atomic(updater.state / 'current-runtime.json', restored)
                if rollback == 'succeeded':
                    atomic(updater.prefix / 'installation/normal.json', read_json(saved / 'previous-normal.json', updater.uid, CATALOG_LIMIT), CATALOG_LIMIT)
            except Exception:
                rollback = 'failed'
        return {'execution': 'failed' if code else 'succeeded', 'verification': 'failed', 'observed': actual,
                'cleanup': 'not_needed', 'rollback': rollback, 'error': 'HOST_UPDATE_INSTALL_FAILED' if code else 'HOST_UPDATE_VERIFICATION_FAILED'}
    check(saved is not None, 'HOST_UPDATE_GENERATION_FAILED')
    atomic(updater.prefix / 'installation/normal.json', read_json(saved / 'normal.json', updater.uid, CATALOG_LIMIT), CATALOG_LIMIT)
    atomic(updater.state / 'current-runtime.json', actual)
    cleanup = 'succeeded'
    try:
        previous = read_json(saved / 'previous-runtime.json', updater.uid)
        rollback_image = previous['Image']
        check(re.fullmatch('sha256:[a-f0-9]{64}', rollback_image), 'HOST_UPDATE_PREVIOUS_IMAGE_INVALID')
        # Reuse the existing cleanup core; failure does not undo a verified healthy new container.
        core = release / 'scripts/cleanup-deploy-images.py'; trusted(core, updater.uid)
        updater.command([config['python'], '-I', '-B', str(core), '--rollback-image', rollback_image], timeout=600)
    except Exception:
        cleanup = 'failed'
    if state_failed:
        # The swap is kept (Trony 2026-11-10), but a failed Aiterm state step is not a completed update.
        return {'execution': 'succeeded', 'verification': 'failed', 'observed': actual, 'cleanup': cleanup,
                'rollback': 'not_needed', 'error': 'HOST_UPDATE_AITERM_STATE_FAILED'}
    return {'execution': 'succeeded', 'verification': 'succeeded', 'observed': actual, 'cleanup': cleanup,
            'rollback': 'not_needed', 'error': None if cleanup == 'succeeded' else 'HOST_UPDATE_CLEANUP_FAILED'}

def verify_root_release(release, source, uid=0):
    manifest_path = release / 'code-manifest.json'
    manifest = read_json(manifest_path, uid)
    receipt = read_json(release / 'installation.json', uid)
    check(receipt.get('schema') == 'bellteam.host-updater.code-installation.v1'
          and receipt.get('sourceCommit') == source and receipt.get('protocolVersion') == 1 and receipt.get('ledgerSchema') == 1
          and receipt.get('manifestSha256') == hashlib.sha256(manifest_path.read_bytes()).hexdigest()
          and re.fullmatch('ghcr.io/kitepon/bellteam-server@sha256:[a-f0-9]{64}', receipt.get('image','')),
          'HOST_UPDATE_CODE_IDENTITY')
    check(exact(manifest, 'schema,sourceCommit,files') and manifest['schema'] == 'bellteam.host-updater.code-manifest.v1'
          and manifest['sourceCommit'] == source and type(manifest['files']) is list and 0 < len(manifest['files']) <= 32,
          'HOST_UPDATE_CODE_INVENTORY')
    inventory = set()
    for item in manifest['files']:
        check(exact(item, 'imagePath,installPath,bytes,sha256') and type(item['installPath']) is str
              and item['installPath'] not in inventory and not item['installPath'].startswith('/')
              and all(part not in {'','..','.'} for part in item['installPath'].split('/'))
              and not re.search(r'[\\\x00-\x1f\x7f]', item['installPath'])
              and type(item['bytes']) is int and 0 <= item['bytes'] <= 16 * CATALOG_LIMIT
              and re.fullmatch('[a-f0-9]{64}', item['sha256']), 'HOST_UPDATE_CODE_INVENTORY')
        path = release / item['installPath']; info = trusted(path, uid)
        check(info.st_size == item['bytes'] and hashlib.sha256(path.read_bytes()).hexdigest() == item['sha256'], 'HOST_UPDATE_CODE_CHANGED')
        inventory.add(item['installPath'])
    actual = {str(path.relative_to(release)) for path in release.rglob('*') if path.is_file()}
    check(actual == inventory | {'code-manifest.json','installation.json'}, 'HOST_UPDATE_CODE_INVENTORY')
    # Validate the full root-managed code/import closure, not just the outer Python entry.
    for root, directories, files in os.walk(release, followlinks=False):
        trusted(root, uid, directory=True)
        for name in directories: trusted(Path(root) / name, uid, directory=True)
        for name in files: trusted(Path(root) / name, uid)

def load():
    check(os.getuid() == os.geteuid() == 0, 'HOST_UPDATE_ROOT_REQUIRED')
    check(sys.version_info >= (3, 11), 'HOST_UPDATE_PYTHON_UNSUPPORTED')
    trusted('/usr/bin/gh')
    config = read_json(PREFIX / 'config.json')
    check(exact(config, 'schema,release,installRoot,projectName,python,node,docker,systemdRun,shell,platform,writePaths')
          and config['schema'] == 'bellteam.host-updater.installation.v1'
          and re.fullmatch('[a-f0-9]{40}', config['release'])
          and re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}', config['projectName'])
          and type(config['writePaths']) is list and len(config['writePaths']) <= 32
          and all(type(path) is str and re.fullmatch(r'/[A-Za-z0-9/._-]+', path) for path in config['writePaths'])
          and config['platform'] in [{'os': 'linux', 'arch': 'amd64'}, {'os': 'linux', 'arch': 'arm64'}], 'HOST_UPDATE_CONFIG_INVALID')
    release = PREFIX / 'releases' / config['release']
    check(Path(__file__).absolute() == release / 'scripts/container-update-host.py', 'HOST_UPDATE_CODE_PIN')
    verify_root_release(release, config['release'])
    for name in ['python', 'node', 'docker', 'systemdRun', 'shell']:
        trusted(config[name])
    for path in sys.path:
        if path and Path(path).exists(): trusted(path, directory=Path(path).is_dir())
    trusted(config['installRoot'], directory=True)
    trusted(PREFIX / 'state', directory=True)
    return HostUpdater(PREFIX, config)

def main():
    updater = load()
    if len(sys.argv) == 3 and sys.argv[1] == '--worker':
        updater.worker(sys.argv[2]); return
    if len(sys.argv) == 2 and sys.argv[1] == '--refresh-catalog':
        refresh_catalog(updater); return
    if len(sys.argv) == 5 and sys.argv[1] == '--install-catalog':
        verify_and_install_catalog(updater, *sys.argv[2:]); return
    if len(sys.argv) == 2 and sys.argv[1] == '--probe':
        # Initial provisioning/read-only probe is run in its own privileged service, never the socket frontend.
        current = updater.inspect_current(); updater.assert_model_binding(current)
        atomic(updater.state / 'current-runtime.json', current); return
    check(len(sys.argv) == 1)
    # The frontend has no Docker socket. The worker revalidates this root-owned observation against actual runtime before accepting.
    updater.inspect = lambda: read_json(updater.state / 'current-runtime.json')
    directory = PREFIX / 'socket'
    info = trusted(directory, directory=True)
    check(info.st_gid == 1001 and stat.S_IMODE(info.st_mode) == 0o750, 'HOST_UPDATE_SOCKET_DIRECTORY')
    with locked(updater.state / 'daemon.lock'):
        path = directory / 'update.sock'
        if os.path.lexists(path):
            st = path.lstat()
            check(stat.S_ISSOCK(st.st_mode) and st.st_uid == 0, 'HOST_UPDATE_SOCKET_INVALID')
            path.unlink()
        with Server(str(path), updater) as server:
            os.chown(path, 0, 1001); os.chmod(path, 0o660)
            bound_inode = path.lstat().st_ino
            try: server.serve_forever(poll_interval=0.2)
            finally:
                if os.path.lexists(path) and path.lstat().st_ino == bound_inode:
                    path.unlink()


def valid_catalog_verification(value):
    return exact(value, 'method,repositoryId,sourceCommit,signerCommit,signerWorkflow') and (
        value['method'] == 'github-oidc-attestation' and value['repositoryId'] == '1404510084'
        and re.fullmatch('[a-f0-9]{40}', value['sourceCommit']) and re.fullmatch('[a-f0-9]{40}', value['signerCommit'])
        and value['signerWorkflow'] == 'kitepon/BellTeam/.github/workflows/publish-update-catalog.yml')

def accept_catalog(updater, raw, receipt):
    check(len(raw) <= CATALOG_LIMIT, 'HOST_UPDATE_CATALOG_LIMIT')
    identifier = hashlib.sha256(raw).hexdigest()
    catalog = decode(raw)
    check(exact(receipt, 'schema,catalogSha256,catalog,verification')
          and receipt['schema'] == 'bellteam.update-catalog.verification.v1'
          and receipt['catalogSha256'] == identifier and receipt['catalog'] == catalog
          and valid_catalog_verification(receipt['verification']), 'HOST_UPDATE_CATALOG_UNTRUSTED')
    check(exact(catalog, 'schema,publishedAt,expiresAt,releases,revokedCatalogs') and catalog['schema'] == 'bellteam.update-catalog.v1'
          and type(catalog['releases']) is list and len(catalog['releases']) <= 128
          and type(catalog['revokedCatalogs']) is list and len(catalog['revokedCatalogs']) <= 1024,
          'HOST_UPDATE_CATALOG_UNTRUSTED')
    published, expires = parse_time(catalog['publishedAt']), parse_time(catalog['expiresAt'])
    check(published <= time.time() + 300 and 0 < expires - published <= 7 * 86400 and expires > time.time(), 'HOST_UPDATE_CATALOG_EXPIRED')
    revoked = {digest(value) for value in catalog['revokedCatalogs']}
    store = updater.prefix / 'catalog'
    trusted(store, updater.uid, directory=True)
    with locked(store / 'catalog.lock'):
        state_path = store / 'state.json'
        previous = read_json(state_path, updater.uid, CATALOG_LIMIT) if state_path.exists() else None
        if previous:
            check(time.time() + 300 >= parse_time(previous['lastObservedAt']), 'HOST_UPDATE_CLOCK_UNCERTAIN')
            prior = parse_time(previous['publishedAt'])
            check(published > prior or published == prior and identifier == previous['catalogSha256'], 'HOST_UPDATE_CATALOG_ROLLBACK', 409)
            revoked.update(previous['revokedCatalogs'])
        check(identifier not in revoked, 'HOST_UPDATE_CATALOG_REVOKED')
        releases = store / 'releases'; releases.mkdir(mode=0o755, exist_ok=True)
        for stale in releases.glob('.catalog-*'):
            trusted(stale, updater.uid, directory=True)
            check({path.name for path in stale.iterdir()} <= {'catalog.json','installation.json'}, 'HOST_UPDATE_CATALOG_STAGE_INVALID')
            stale.chmod(0o700)
            for path in stale.iterdir(): trusted(path, updater.uid); path.unlink()
            stale.rmdir()
        target = releases / identifier
        if not target.exists():
            stage = Path(tempfile.mkdtemp(prefix='.catalog-', dir=releases))
            try:
                def write(name, data):
                    fd = os.open(stage / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
                    with os.fdopen(fd, 'wb') as output:
                        output.write(data); output.flush(); os.fchmod(output.fileno(), 0o444); os.fsync(output.fileno())
                write('catalog.json', raw)
                installed = {'schema': 'bellteam.update-catalog.installation.v1', 'catalogSha256': identifier,
                             'publishedAt': catalog['publishedAt'], 'expiresAt': catalog['expiresAt'], 'verification': receipt['verification']}
                write('installation.json', (json.dumps(installed) + '\n').encode())
                os.chmod(stage, 0o555)
                # Root-only parents plus the stable catalog lock exclude another publisher/rename target.
                check(not target.exists(), 'HOST_UPDATE_CATALOG_EXISTS')
                publish_directory(stage, target)
                parent = os.open(releases, os.O_RDONLY | os.O_DIRECTORY)
                try: os.fsync(parent)
                finally: os.close(parent)
            finally:
                if stage.exists():
                    os.chmod(stage, 0o700)
                    for file in stage.iterdir(): file.unlink()
                    stage.rmdir()
        else:
            existing = read_json(target / 'installation.json', updater.uid)
            check(existing.get('catalogSha256') == identifier and (target / 'catalog.json').read_bytes() == raw, 'HOST_UPDATE_CATALOG_CHANGED')
        state = {'schema': 'bellteam.update-catalog.state.v1', 'catalogSha256': identifier, 'publishedAt': catalog['publishedAt'],
                 'expiresAt': catalog['expiresAt'], 'revokedCatalogs': sorted(revoked), 'lastObservedAt': stamp()}
        atomic(state_path, state, CATALOG_LIMIT)
        return identifier

def verify_and_install_catalog(updater, catalog_path, bundle_path, expectation=None, *, runtime_for=None):
    release = updater.code_root
    verifier = release / 'scripts/verify-update-catalog.py'; trusted(verifier, updater.uid)
    if expectation:
        expected = read_json(expectation, updater.uid)
        check(exact(expected, 'catalogSha256,sourceCommit,signerCommit') and digest(expected['catalogSha256'])
              and all(re.fullmatch('[a-f0-9]{40}', expected[key]) for key in ['sourceCommit', 'signerCommit']), 'HOST_UPDATE_CATALOG_EXPECTATION')
    with tempfile.TemporaryDirectory(prefix='catalog-verify-', dir=updater.state) as staging:
        paths = []
        for source, name, limit in [(catalog_path, 'catalog.json', CATALOG_LIMIT), (bundle_path, 'bundle.json', 16 * CATALOG_LIMIT)]:
            fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                before = os.fstat(fd)
                check(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= limit, 'HOST_UPDATE_CATALOG_INPUT')
                with os.fdopen(fd, 'rb', closefd=False) as input_file: raw = input_file.read(limit + 1)
                after = os.fstat(fd)
                check(len(raw) <= limit and (before.st_ino,before.st_dev,before.st_size,before.st_mtime_ns,before.st_ctime_ns)
                      == (after.st_ino,after.st_dev,after.st_size,after.st_mtime_ns,after.st_ctime_ns), 'HOST_UPDATE_CATALOG_INPUT_CHANGED')
            finally: os.close(fd)
            target = Path(staging) / name; target.write_bytes(raw); target.chmod(0o400); paths.append(target)
        # Isolated Python omits sibling imports; add only the already validated immutable root closure.
        loader = 'import runpy,sys;sys.path.insert(0,sys.argv[1]);entry=sys.argv[2];sys.argv=[entry,*sys.argv[3:]];runpy.run_path(entry,run_name="__main__")'
        args = [updater.config['python'], '-I', '-B', '-S', '-c', loader, str(release / 'scripts'), str(verifier)]
        if expectation:
            target = Path(staging) / 'expectation.json'; atomic(target, expected)
            args += [str(paths[0]), str(paths[1]), str(target)]
        else: args += ['--publisher', *(['--runtime'] if runtime_for else []), str(paths[0]), str(paths[1])]
        output = updater.command(args, timeout=120)
        check(len(output) <= 4 * CATALOG_LIMIT, 'HOST_UPDATE_CATALOG_RECEIPT_LIMIT')
        if runtime_for: return accept_runtime_catalog(updater, paths[0].read_bytes(), decode(output), runtime_for)
        return accept_catalog(updater, paths[0].read_bytes(), decode(output))

def accept_runtime_catalog(updater, raw, receipt, catalog_id):
    # Z-b2: runtime rows ride a separate signed asset bound to one accepted main catalog, so released readers never see them.
    check(exact(receipt, 'schema,runtimeCatalogSha256,runtimeCatalog,verification')
          and receipt['schema'] == 'bellteam.runtime-catalog.verification.v1'
          and receipt['runtimeCatalogSha256'] == hashlib.sha256(raw).hexdigest() and receipt['runtimeCatalog'] == decode(raw)
          and receipt['runtimeCatalog'].get('catalogSha256') == catalog_id
          and valid_catalog_verification(receipt['verification']), 'HOST_UPDATE_CATALOG_UNTRUSTED')
    store = updater.prefix / 'catalog' / 'runtime'
    store.mkdir(mode=0o755, exist_ok=True); trusted(store, updater.uid, directory=True)
    atomic(store / (catalog_id + '.json'), receipt, CATALOG_LIMIT)
    return catalog_id

def runtime_rows(updater, catalog_id):
    path = updater.prefix / 'catalog' / 'runtime' / (catalog_id + '.json')
    if not path.exists(): return []
    receipt = read_json(path, updater.uid, CATALOG_LIMIT)
    try:
        trusted_rows = (receipt['schema'] == 'bellteam.runtime-catalog.verification.v1'
          and receipt['runtimeCatalog']['catalogSha256'] == catalog_id and valid_catalog_verification(receipt['verification'])
          and type(receipt['runtimeCatalog']['releases']) is list)
    except (KeyError, TypeError): trusted_rows = False
    check(trusted_rows, 'HOST_UPDATE_CATALOG_UNTRUSTED')
    return receipt['runtimeCatalog']['releases']

RELEASE_DOWNLOAD = 'https://github.com/kitepon/BellTeam/releases/download/'
PUBLICATION_RETRY_WINDOW = 60

def fetch_publication(opener, url, limit, sleep=time.sleep, clock=time.monotonic):
    """One public read. Transient HTTP/network failures retry within 60 s; github.com can keep answering one exact
    release URL with a cached 504, so a release retry adds a one-off query (same host/path; bytes are verified after)."""
    import urllib.request, urllib.error, http.client
    deadline, delay, attempt = clock() + PUBLICATION_RETRY_WINDOW, 2, 0
    while True:
        target = url if attempt == 0 or not url.startswith(RELEASE_DOWNLOAD) else f'{url}?attempt={attempt}-{time.time_ns()}'
        attempt += 1
        try:
            with opener.open(urllib.request.Request(target, headers={'User-Agent':'BellTeam-Updater','Accept':'application/vnd.github+json'}), timeout=15) as response:
                check(response.status == 200, 'HOST_UPDATE_PUBLICATION_UNAVAILABLE')
                raw = response.read(limit + 1)
            break
        except urllib.error.HTTPError as error:
            if error.code not in {408, 425, 429, 500, 502, 503, 504} or clock() + delay > deadline: raise
        except (urllib.error.URLError, OSError, http.client.IncompleteRead):
            if clock() + delay > deadline: raise
        sleep(delay); delay = min(delay * 2, 15)
    check(len(raw) <= limit, 'HOST_UPDATE_PUBLICATION_LIMIT'); return raw

def _refresh_catalog(updater):
    opener = publication_opener()
    fetch = lambda url, limit: fetch_publication(opener, url, limit)
    rows = decode(fetch('https://api.github.com/repos/kitepon/BellTeam/releases?per_page=100', 4 * CATALOG_LIMIT))
    # Distribution owns the formal publication selector; root still authenticates every selected byte.
    import importlib.util
    script = updater.code_root/'scripts/update_catalog.py'
    trusted(script, updater.uid)
    spec = importlib.util.spec_from_file_location('bellteam_catalog_discovery', script)
    discovery = importlib.util.module_from_spec(spec); spec.loader.exec_module(discovery)
    candidates = sorted(discovery.publication_candidates(rows, updater.config.get('channel', 'stable')),key=lambda value:value['tag'],reverse=True)
    check(bool(candidates), 'HOST_UPDATE_PUBLICATION_UNAVAILABLE')
    tag = candidates[0]['tag']
    with tempfile.TemporaryDirectory(prefix='catalog-fetch-', dir=updater.state) as staging:
        for name, limit in [('catalog.json', CATALOG_LIMIT), ('catalog.json.sigstore.json', 16 * CATALOG_LIMIT)]:
            raw = fetch('https://github.com/kitepon/BellTeam/releases/download/' + tag + '/' + name, limit)
            (Path(staging) / name).write_bytes(raw)
        identifier = verify_and_install_catalog(updater, Path(staging)/'catalog.json', Path(staging)/'catalog.json.sigstore.json')
        try:
            for name, limit in [('runtime-catalog.json', CATALOG_LIMIT), ('runtime-catalog.json.sigstore.json', 16 * CATALOG_LIMIT)]:
                raw = fetch('https://github.com/kitepon/BellTeam/releases/download/' + tag + '/' + name, limit)
                (Path(staging) / name).write_bytes(raw)
            verify_and_install_catalog(updater, Path(staging)/'runtime-catalog.json', Path(staging)/'runtime-catalog.json.sigstore.json', runtime_for=identifier)
        except Exception:
            pass # Optional asset: absent or invalid leaves runtime targets unavailable; the accepted main catalog stands.
        return identifier
REFRESH_LOCK = threading.Lock() # Serializes the background thread and on-demand checks so two catalog installs never overwrite each other.
def refresh_catalog(updater):
    path = updater.prefix/'catalog/refresh.json'
    with REFRESH_LOCK:
        try:
            identifier = _refresh_catalog(updater)
        except Exception:
            atomic(path, {'status':'failed','checkedAt':stamp(),'error':'HOST_UPDATE_PUBLICATION_UNCONFIRMED'})
            raise
        atomic(path, {'status':'verified','checkedAt':stamp(),'error':None})
        return identifier

if __name__ == '__main__':
    try: main()
    except (Exception, KeyboardInterrupt):
        sys.stderr.write('HOST_UPDATE_STOPPED\n'); sys.exit(1)
