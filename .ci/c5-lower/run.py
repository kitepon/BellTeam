"""CI-only adapter for pinned lower functions; no production entry or receipt."""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import time
import uuid
from unittest.mock import patch

import c5_helper_lab as lower
from c5_contract import ContractError
from c5_product_hooks import CONFIG_HASH, INSPECT_TEMPLATE
from c5_state import container_record, read_state_identity, write_state

HERE = Path(__file__).resolve().parent
GIB = 1024 ** 3
IMAGE = 'ghcr.io/kitepon/bellteam-server@sha256:c5a20bd36a8f3ee3fd6e7f23872931125e159a45baf7e01a56185fbb7c5e4c2e'
CAPS = {'nano_cpus': 1_000_000_000, 'memory_bytes': 2 * GIB,
        'memory_swap_bytes': 2 * GIB, 'pids_limit': 512}
INFO = '{"root":{{json .DockerRootDir}},"os":{{json .OSType}},"arch":{{json .Architecture}},"cgroup":{{json .CgroupVersion}}}'
IMAGE_INFO = '{"id":{{json .Id}},"arch":{{json .Architecture}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}}}'
VOLUME_INFO = '{"name":{{json .Name}},"driver":{{json .Driver}},"options":{{json .Options}},"run":{{json (index .Labels "c5.run")}},"created":{{json .CreatedAt}}}'
NETWORK_INFO = '{"id":{{json .Id}},"name":{{json .Name}},"driver":{{json .Driver}},"project":{{json (index .Labels "com.docker.compose.project")}},"containers":{{len .Containers}}}'


class Refused(ContractError):
    pass


def utc():
    return datetime.now(timezone.utc).isoformat()


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def exact_cid(raw):
    value = raw.decode('ascii').strip()
    if not re.fullmatch('[0-9a-f]{64}', value):
        raise Refused('CI_CID_UNKNOWN')
    return value


def hash_line(raw):
    fields = raw.decode('ascii').strip().split()
    if len(fields) != 2 or fields[0] != 'bellteam' or not re.fullmatch('[0-9a-f]{64}', fields[1]):
        raise Refused('CI_HASH_REPRESENTATION')
    return fields[1]


def public_helper(item):
    """Only fields used for this fixture's acceptance; never Config.Env/Health.Log."""
    return {
        'Id': item['Id'], 'Name': item['Name'], 'Image': item['Image'],
        'Config': {key: item['Config'].get(key) for key in ('Image', 'User', 'Entrypoint', 'Cmd')},
        'Labels': {key: item['Config'].get('Labels', {}).get(key) for key in
                   ('c5.run', 'c5.ordinal', 'com.docker.compose.project',
                    'com.docker.compose.service', 'com.docker.compose.config-hash')},
        'HostConfig': {key: item['HostConfig'].get(key) for key in
                       ('NanoCpus', 'Memory', 'MemorySwap', 'PidsLimit', 'ReadonlyRootfs',
                        'NetworkMode', 'CapDrop', 'SecurityOpt', 'Init', 'Tmpfs')},
        'State': {key: item['State'].get(key) for key in
                  ('Status', 'Running', 'Pid', 'ExitCode', 'OOMKilled', 'StartedAt', 'FinishedAt')},
        'Mounts': [{key: mount.get(key) for key in ('Type', 'Name', 'Destination', 'RW')}
                   for mount in item['Mounts']],
    }


class Harness:
    def __init__(self, root, contract, *, clock=time.monotonic, probe=None, epoch=None):
        self.root, self.contract = Path(root), contract
        self.root.mkdir(mode=0o700, parents=True, exist_ok=False)
        self.clock, self.probe = clock, probe or self.resources
        self.end = self.clock() + contract['scriptSeconds']
        self.phase_end = self.clock()
        self.docker_root = Path('/var/lib/docker')
        self.initial_free = None
        self.held = self.unknown = self.cleanup_mode = False
        self.active = None
        self.project = epoch or f"centi-c5-low-{os.environ.get('GITHUB_RUN_ID', 'local')}-a1-{uuid.uuid4().hex[:8]}"
        self.volume, self.network = self.project + '-cursor', self.project + '_default'
        self.volume_identity = None
        self.volume_may_exist = False
        self.network_identity = None
        self.network_expected = False
        self.start_approval = self.rm_approval = None
        runtime = self.root / 'runtime'
        runtime.mkdir(mode=0o700)
        self.subject_path = self.root / 'operator-state.json'
        self.subject = {'ci_lower_level_only': True, 'phaseOrdinal': 1, 'phase': 'prepare',
                        'phaseStatus': 'prepared', 'commands': [], 'containers': [], 'phaseEvents': []}
        self.plan = {'mode': 'production', 'state_dir': str(runtime), 'epoch': self.project,
                     'run': self.project, 'window_end': (datetime.now(timezone.utc) + timedelta(seconds=contract['scriptSeconds'])).isoformat(),
                     'observer_source_dir': str(runtime / 'unused-no-observer'),
                     'image': IMAGE, 'helper_caps': CAPS, 'cursor_volume': self.volume,
                     'cursor_network_mode': self.network}
        self.cursor_files = ['compose', '-p', self.project, '-f', str(HERE / 'assets/compose.cursor-update.yaml'),
                             '-f', str(HERE / 'cursor-caps.overlay.yaml')]
        self.fixture_files = ['compose', '-p', self.project, '-f', str(HERE / 'projection-fixture.json')]
        self.input_env = {'COMPOSE_PROJECT_NAME': self.project, 'COMPOSE_FILE': str(HERE / 'projection-fixture.json'),
                          'BELLTEAM_SERVER_IMAGE': IMAGE, 'BELLTEAM_CURSOR_UPDATE_IMAGE': IMAGE,
                          'BELLTEAM_CURSOR_VOLUME': self.volume}
        self.helpers = []
        self.state = {'context': 'ci_lower_level_only', 'image': IMAGE, 'run': self.project,
                      'complete': False, 'productionReady': False, 'commands': [], 'phases': [],
                      'containers': self.helpers, 'claims': [], 'startedAt': utc(),
                      'expectedNames': [self.project + '-asset', self.project + '-cursor-update-1', self.project + '-projection']}
        write_state(self.subject_path, self.subject)
        self.claim('epoch')

    def save(self):
        self.state.update(held=self.held, unknown=self.unknown, updatedAt=utc())
        write_state(self.root / 'harness-state.json', self.state)

    def claim(self, name):
        if not re.fullmatch('[a-z0-9-]+', name):
            raise Refused('CI_CLAIM_NAME')
        with (self.root / (name + '.claim')).open('x') as stream:
            os.chmod(stream.name, 0o600)
            json.dump({'run': self.project, 'action': name, 'at': utc()}, stream)
            stream.flush(); os.fsync(stream.fileno())
        self.state['claims'].append(name)
        self.save()

    def resources(self):
        memory = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
        disk = os.statvfs(self.docker_root)
        return {'at': self.clock(), 'mem': int(memory['MemAvailable'].split()[0]) * 1024,
                'free': disk.f_bavail * disk.f_frsize, 'utc': utc()}

    def resource_check(self, initial=False):
        sample = self.probe()
        if (type(sample.get('at')) not in (int, float) or not 0 <= self.clock() - sample['at'] <= 3
            or any(type(sample.get(key)) is not int for key in ('mem', 'free'))):
            raise Refused('CI_RESOURCE_MISSING_STALE')
        if sample['mem'] < (8 if initial else 4) * GIB or sample['free'] < (24 if initial else 8) * GIB:
            raise Refused('CI_RESOURCE_HEADROOM')
        if self.initial_free is not None and self.initial_free - sample['free'] > 16 * GIB:
            raise Refused('CI_DISK_GROWTH')
        self.state['lastResource'] = sample
        return sample

    def budget(self):
        reserve = 0 if self.cleanup_mode else self.contract['cleanupSeconds'] + self.contract['decisionSeconds']
        left = min(self.phase_end, self.end - reserve) - self.clock()
        if left <= 0:
            raise Refused('CI_PRESPAWN_DEADLINE')
        return left

    def phase(self, name, ordinal, cleanup=False):
        seconds = self.contract['phaseSeconds'][name]
        reserve = 0 if cleanup else self.contract['cleanupSeconds'] + self.contract['decisionSeconds']
        if self.clock() + seconds + reserve > self.end or (not cleanup and (self.held or self.unknown)):
            raise Refused('CI_PHASE_HELD_OR_BUDGET')
        self.cleanup_mode = cleanup
        self.phase_end = self.clock() + seconds
        self.subject.update(phase=name, phaseOrdinal=ordinal)
        self.state['phase'] = name
        self.state['phases'].append({'name': name, 'startUTC': utc(), 'deadline': self.phase_end})
        self.save()

    def allow_argv(self, argv):
        ids = {h['id'] for h in self.helpers}
        if self.cleanup_mode and argv[0] not in ('inspect', 'rm', 'container', 'volume', 'network'):
            raise Refused('CI_CLEANUP_ARGV')
        if argv in (['version', '--format', '{{.Client.Version}}'], ['compose', 'version', '--short'],
                    ['info', '--format', INFO], ['pull', '--quiet', '--platform', 'linux/amd64', IMAGE],
                    ['image', 'inspect', '--format', IMAGE_INFO, IMAGE]):
            return
        if len(argv) == 2 and argv[0] == 'inspect' and argv[1] in ids:
            return
        if (len(argv) == 2 and argv[0] == 'rm' and argv[1] in ids and self.rm_approval
            and self.rm_approval[0] == argv[1] and 0 <= self.clock() - self.rm_approval[1] <= 3):
            return
        if len(argv) == 3 and argv[:2] == ['start', '-a'] and any(h['id'] == argv[2] and h['kind'] != 'cursor' for h in self.helpers):
            if self.start_approval and self.start_approval[0] == argv[2] and 0 <= self.clock() - self.start_approval[1] <= 3:
                return
            raise Refused('CI_START_WITHOUT_FRESH_INSPECT')
        if (len(argv) == 6 and argv[:5] == ['inspect', '--type', 'container', '--format', INSPECT_TEMPLATE]
            and any(h['id'] == argv[5] and h['kind'] == 'projection' for h in self.helpers)):
            return
        asset = ['create', '--name', self.project + '-asset', '--label', 'c5.run=' + self.project,
                 '--label', 'c5.ordinal=2', '--cpus', '1', '--memory', '2g', '--memory-swap', '2g',
                 '--pids-limit', '512', '--pull', 'never', '--network', 'none', '--read-only',
                 '--entrypoint', '/bin/cat', IMAGE, '/app/compose.cursor-update.yaml']
        if argv == asset:
            return
        if argv[:len(self.cursor_files)] == self.cursor_files and argv[len(self.cursor_files):] in (
            ['config', '--format', 'json'], ['create', 'cursor-update'], ['ps', '--all', '-q', 'cursor-update']):
            return
        if argv[:len(self.fixture_files)] == self.fixture_files and argv[len(self.fixture_files):] in (
            list(CONFIG_HASH[1:]), ['create', '--no-build', '--pull', 'never', 'bellteam'],
            ['ps', '--all', '-q', 'bellteam']):
            return
        reads = [
            ['volume', 'ls', '--filter', 'name=^' + self.volume + '$', '--format', '{{.Name}}'],
            ['network', 'ls', '--filter', 'name=^' + self.network + '$', '--format', '{{.Name}}'],
            ['volume', 'inspect', '--format', VOLUME_INFO, self.volume],
            ['network', 'inspect', '--format', NETWORK_INFO, self.network],
            ['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', 'volume=' + self.volume],
        ]
        for name in self.state['expectedNames']:
            reads.append(['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', 'name=^/' + name + '$'])
        for identifier in ids:
            reads.append(['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', 'id=' + identifier])
        if argv in reads or argv == ['volume', 'create', '--label', 'c5.run=' + self.project, self.volume]:
            return
        if argv == ['volume', 'rm', self.volume] and self.state.get('volumeRemovalApproved'):
            return
        if argv == ['network', 'rm', self.state.get('networkId')] and self.state.get('networkRemovalApproved'):
            return
        raise Refused('CI_ARGV')

    def guard(self):
        if self.unknown or self.subject.get('latch') or (self.held and not self.cleanup_mode):
            raise Refused('CI_LATCHED')
        self.resource_check()
        return self.budget()

    def spawn_guard(self, argv, env):
        row = self.active
        if row is None or argv != ['/usr/bin/docker', *row['argv']]:
            raise Refused('CI_SPAWN_ARGV')
        self.allow_argv(row['argv'])
        expected = {'PATH': '/usr/bin:/bin', 'HOME': '/home/kite', 'LANG': 'C.UTF-8',
                    'DOCKER_CONFIG': str(Path(self.plan['state_dir']) / 'empty-docker-config'),
                    **self.input_env, 'C5_EPOCH': self.project,
                    'C5_ORDINAL': str(row['envOrdinal']), 'C5_STATE_PATH': str(self.subject_path)}
        if env != expected:
            raise Refused('CI_MINIMAL_ENV')
        env_sha = digest(json.dumps(expected, sort_keys=True).encode())
        self.state.setdefault('environments', {})[env_sha] = expected
        row['environmentSHA256'] = env_sha
        self.save()
        # Claim, env and receipt I/O must not consume the final pre-spawn guard.
        self.guard()
        reserve = 0 if self.cleanup_mode else self.contract['cleanupSeconds'] + self.contract['decisionSeconds']
        if self.clock() + row['seconds'] + 1 > min(self.phase_end, self.end - reserve):
            raise Refused('CI_FULL_CALL_BUDGET_UNAVAILABLE')
        self.allow_argv(row['argv'])
        row['spawnAttemptedAt'] = utc()

    def reap_guard(self, pid):
        saved, _ = read_state_identity(self.subject_path)
        current_ticks = saved.get('helperClientStartTicks')
        rows = [row for row in saved.get('commands', [])
                if row['pid'] == pid and row.get('endedAt') and row.get('startTicks') == current_ticks
                and row.get('phaseOrdinal') == saved.get('phaseOrdinal')]
        if (saved.get('helperClientPid') == pid and type(current_ticks) is int and current_ticks > 0
            and len(rows) == 1 and rows[0].get('terminal')):
            receipt = {'pid': pid, 'startTicks': rows[0]['startTicks'], 'terminal': rows[0]['terminal'], 'class': 'terminal'}
        elif saved.get('latch') is True and saved.get('phaseStatus') == 'unknown' and saved.get('helperClientPid') == pid:
            receipt = {'pid': pid, 'class': 'unknown_only'}
        else:
            raise Refused('CI_REAP_WITHOUT_DURABLE_RECEIPT')
        self.state.setdefault('reapTrace', []).append({**receipt, 'beforeRealReapUTC': utc()})
        self.save()

    def process_type(self, base):
        owner = self

        class Observed(base):
            def __init__(self, argv, **kwargs):
                owner.spawn_guard(argv, kwargs.get('env'))
                super().__init__(argv, **kwargs)
                owner.active['pid'] = self.pid
                owner.active['spawned'] = True

            def wait(self, *args, **kwargs):
                if self.returncode is not None:
                    raise Refused('CI_CLIENT_ALREADY_REAPED')
                owner.reap_guard(self.pid)
                result = super().wait(*args, **kwargs)
                owner.state.setdefault('reaped', []).append({'pid': self.pid, 'code': result, 'at': utc()})
                owner.save()
                return result

        return Observed

    def invoke(self, argv, effect=None, inspect=None):
        try:
            self.allow_argv(argv)
            self.guard()
            if len(self.state['commands']) >= self.contract['maxDockerCommands']:
                raise Refused('CI_COMMAND_LIMIT')
            if effect:
                self.claim(effect)
        except Exception:
            self.held = True
            self.save()
            raise
        row = {'argv': argv, 'effect': effect, 'phase': self.state['phase'], 'preparedAt': utc(), 'spawned': False,
               'envOrdinal': inspect[0]['ordinal'] if inspect else self.subject['phaseOrdinal']}
        self.state['commands'].append(row)
        self.active = row
        self.save()
        try:
            seconds = min(self.guard() - 2, 300 if argv[0] == 'pull' else 20)
            if seconds <= 0:
                raise Refused('CI_CALL_REAP_RESERVE')
            row['seconds'] = seconds
            deadline = datetime.now(timezone.utc) + timedelta(seconds=seconds)
            with patch.dict(os.environ, self.input_env, clear=True), patch.object(subprocess, 'Popen', self.process_type(subprocess.Popen)):
                if inspect is None:
                    result = lower._run(self.plan, self.subject, self.subject_path, argv, deadline, self.subject['phaseOrdinal'])
                    row.update(stdoutBytes=len(result), stdoutSHA256=digest(result))
                else:
                    h, status = inspect
                    result = lower._inspect(self.plan, self.subject, self.subject_path, h['id'], deadline,
                                            h['ordinal'], h['name'], status, h['kind'], h.get('asset'))
                    row['samePinnedInspectAccepted'] = True
            row.update(outcome='finished', finishedAt=utc())
            return result
        except Exception:
            self.held = True
            self.unknown = bool(row.get('spawned') or row.get('spawnAttemptedAt'))
            row['outcome'] = 'unknown' if self.unknown else 'not_spawned_held'
            raise
        finally:
            self.save()
            self.active = None

    def remember(self, identifier, name, kind, ordinal):
        h = {'id': identifier, 'name': name, 'kind': kind, 'ordinal': ordinal, 'status': 'created'}
        h['runtimeEvidence'] = {'status': 'not_observed', 'samples': [],
                                'limit': 'created-only Cursor; short-lived fixture PID/cgroup/peak not sampled'}
        if kind == 'asset':
            h['asset'] = '/app/compose.cursor-update.yaml'
        self.helpers.append(h)
        container_record(self.subject, name, identifier, False, False)
        self.save()
        return h

    def created(self, raw, name, kind, ordinal):
        try:
            identifier = exact_cid(raw)
            if any(h['id'] == identifier for h in self.helpers):
                raise Refused('CI_DUPLICATE_CID')
            return self.remember(identifier, name, kind, ordinal)
        except (ValueError, Refused):
            self.held = self.unknown = True
            self.save()
            raise

    def inspect(self, h, status):
        if h['kind'] in ('asset', 'cursor'):
            item = self.invoke(['inspect', h['id']], inspect=(h, status))
        else:
            values = json.loads(self.invoke(['inspect', h['id']]))
            if not isinstance(values, list) or len(values) != 1:
                raise Refused('CI_INSPECT_REPRESENTATION')
            item = values[0]
        config, state, host = item['Config'], item['State'], item['HostConfig']
        if (item['Id'] != h['id'] or item['Name'] != '/' + h['name'] or item['Image'] != self.contract['amd64Config']
            or config['Image'] != IMAGE or config['Labels'].get('c5.run') != self.project
            or config['Labels'].get('c5.ordinal') != str(h['ordinal']) or state['Status'] != status
            or state['Running'] is not False or type(state['Pid']) is not int or state['Pid'] != 0
            or state['OOMKilled'] is not False
            or (status == 'exited' and (type(state['ExitCode']) is not int or state['ExitCode'] != 0))
            or host['ReadonlyRootfs'] is not True
            or any(type(host[k]) is not int or host[k] != value for k, value in
                   [('NanoCpus', 1_000_000_000), ('Memory', 2 * GIB), ('MemorySwap', 2 * GIB), ('PidsLimit', 512)])):
            raise Refused('CI_NOT_KNOWN_OWNED_STOPPED')
        if h['kind'] == 'projection' and (item['Mounts'] != [] or host['NetworkMode'] != 'none'
            or config['Entrypoint'] != ['/usr/local/bin/node'] or config['User'] != '1000:1000'
            or config['Cmd'] != ['-e', 'setTimeout(()=>process.exit(0),5000)']
            or host['CapDrop'] != ['ALL'] or host['SecurityOpt'] != ['no-new-privileges:true']):
            raise Refused('CI_PROJECTION_ACCESS')
        write_state(self.root / f"inspect-{h['kind']}-{status}.json", public_helper(item))
        if status == 'created' and h['kind'] != 'cursor':
            self.start_approval = (h['id'], self.clock())
        return item

    def remove(self, h):
        self.inspect(h, h['status'])
        self.rm_approval = (h['id'], self.clock())
        try:
            self.invoke(['rm', h['id']], 'rm-' + h['kind'])
        finally:
            self.rm_approval = None
        remaining = self.invoke(['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', 'id=' + h['id']])
        if remaining.strip():
            self.unknown = True
            raise Refused('CI_CONTAINER_REMAINS')
        h['status'] = 'removed'
        container_record(self.subject, h['name'], h['id'], False, True)
        self.save()

    def volume_check(self):
        current = json.loads(self.invoke(['volume', 'inspect', '--format', VOLUME_INFO, self.volume]))
        if (current.get('name') != self.volume or current.get('driver') != 'local' or current.get('options') not in (None, {})
            or current.get('run') != self.project or not current.get('created')
            or (self.volume_identity is not None and current != self.volume_identity)):
            raise Refused('CI_VOLUME_IDENTITY')
        self.volume_identity = current

    def cleanup(self):
        if self.unknown:
            self.state['cleanup'] = 'incomplete_unknown_no_more_Docker'
            return
        self.phase('cleanup', 12, cleanup=True)
        for h in self.helpers:
            if h['status'] != 'removed':
                self.remove(h)
        if self.volume_may_exist and not self.volume_identity:
            raise Refused('CI_VOLUME_IDENTITY_UNCONFIRMED')
        if self.volume_identity:
            self.volume_check()
            users = self.invoke(['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', 'volume=' + self.volume])
            if users.strip():
                raise Refused('CI_VOLUME_REFERENCED')
            self.state['volumeRemovalApproved'] = True
            self.invoke(['volume', 'rm', self.volume], 'volume-rm')
            if self.invoke(['volume', 'ls', '--filter', 'name=^' + self.volume + '$', '--format', '{{.Name}}']).strip():
                raise Refused('CI_VOLUME_REMAINS')
            self.volume_identity = None
            self.volume_may_exist = False
        if self.network_expected:
            net = json.loads(self.invoke(['network', 'inspect', '--format', NETWORK_INFO, self.network]))
            if (net['name'] != self.network or net['driver'] != 'bridge' or net['project'] != self.project
                or type(net['containers']) is not int or net['containers'] != 0 or not self.network_identity
                or any(net[key] != self.network_identity[key] for key in ('id', 'name', 'driver', 'project'))):
                raise Refused('CI_NETWORK_NOT_OWNED_EMPTY')
            self.state['networkId'] = exact_cid(net['id'].encode())
            self.state['networkRemovalApproved'] = True
            self.invoke(['network', 'rm', net['id']], 'network-rm')
            if self.invoke(['network', 'ls', '--filter', 'name=^' + self.network + '$', '--format', '{{.Name}}']).strip():
                raise Refused('CI_NETWORK_REMAINS')
            self.network_expected = False
        self.state['cleanup'] = 'complete'

    def run(self):
        try:
            self.phase('preflight', 1)
            frames = self.state['initialFrames'] = []
            for i in range(4):
                sample = self.resource_check(initial=True)
                if frames and not 0 < sample['at'] - frames[-1]['at'] <= 2.5:
                    raise Refused('CI_INITIAL_INTERVAL')
                frames.append(sample)
                self.initial_free = self.initial_free or sample['free']
                if i < 3:
                    time.sleep(1)
            self.invoke(['version', '--format', '{{.Client.Version}}'])
            self.invoke(['compose', 'version', '--short'])
            info = json.loads(self.invoke(['info', '--format', INFO]))
            if (info['os'] != 'linux' or info['arch'] not in ('amd64', 'x86_64') or info['cgroup'] != '2'
                or not Path(info['root']).is_absolute()
                or os.stat(info['root']).st_dev != self.docker_root.stat().st_dev):
                raise Refused('CI_DAEMON_IDENTITY_OR_DIFFERENT_FILESYSTEM')
            self.docker_root = Path(info['root'])
            for name in self.state['expectedNames']:
                if self.invoke(['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', 'name=^/' + name + '$']).strip():
                    raise Refused('CI_EXISTING_CONTAINER')
            self.phase('pull', 1)
            self.invoke(['pull', '--quiet', '--platform', 'linux/amd64', IMAGE], 'pull')
            image = json.loads(self.invoke(['image', 'inspect', '--format', IMAGE_INFO, IMAGE]))
            if image != {'id': self.contract['amd64Config'], 'arch': 'amd64', 'revision': self.contract['source']}:
                raise Refused('CI_IMAGE_BINDING')
            self.phase('asset', 2)
            name = self.project + '-asset'
            argv = ['create', '--name', name, '--label', 'c5.run=' + self.project, '--label', 'c5.ordinal=2',
                    '--cpus', '1', '--memory', '2g', '--memory-swap', '2g', '--pids-limit', '512', '--pull', 'never',
                    '--network', 'none', '--read-only', '--entrypoint', '/bin/cat', IMAGE, '/app/compose.cursor-update.yaml']
            asset = self.created(self.invoke(argv, 'create-asset'), name, 'asset', 2)
            self.inspect(asset, 'created')
            content = self.invoke(['start', '-a', asset['id']], 'start-asset')
            if digest(content) != self.contract['pins']['assets/compose.cursor-update.yaml']:
                raise Refused('CI_ASSET_SHA')
            asset['status'] = 'exited'
            self.inspect(asset, 'exited'); self.remove(asset)
            self.phase('cursor', 8)
            config = json.loads(self.invoke([*self.cursor_files, 'config', '--format', 'json']))
            cursor = config['services']['cursor-update']
            if (set(config['services']) != {'cursor-update'} or cursor['image'] != IMAGE
                or any(cursor.get(k) for k in ('environment', 'env_file', 'secrets', 'configs', 'ports', 'build'))
                or config['volumes']['cursor-cli']['name'] != self.volume
                or config['volumes']['cursor-cli'].get('external') is not True
                or config['networks']['default']['name'] != self.network):
                raise Refused('CI_CURSOR_COMPOSE')
            for kind, name in [('volume', self.volume), ('network', self.network)]:
                if self.invoke([kind, 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}']).strip():
                    raise Refused('CI_EXISTING_RESOURCE')
            self.volume_may_exist = True
            self.invoke(['volume', 'create', '--label', 'c5.run=' + self.project, self.volume], 'volume-create')
            self.volume_check()
            self.network_expected = True
            self.invoke(lower.cursor_create_argv(self.cursor_files), 'create-cursor')
            self.network_identity = json.loads(self.invoke(['network', 'inspect', '--format', NETWORK_INFO, self.network]))
            if (self.network_identity['name'] != self.network or self.network_identity['project'] != self.project
                or self.network_identity['driver'] != 'bridge'):
                raise Refused('CI_NETWORK_IDENTITY')
            exact_cid(self.network_identity['id'].encode())
            h = self.created(self.invoke([*self.cursor_files, 'ps', '--all', '-q', 'cursor-update']),
                             self.project + '-cursor-update-1', 'cursor', 8)
            self.inspect(h, 'created'); self.remove(h)
            self.phase('projection-create', 11)
            # helper_environment intentionally does not pass arbitrary CI variables.
            fixture = json.loads((HERE / 'projection-fixture.json').read_text())
            fixture['services']['bellteam']['container_name'] = self.project + '-projection'
            concrete = self.root / 'projection-fixture.json'
            concrete.write_text(json.dumps(fixture))
            self.fixture_files = ['compose', '-p', self.project, '-f', str(concrete)]
            self.input_env['COMPOSE_FILE'] = str(concrete)
            hash_raw = self.invoke([*self.fixture_files, *CONFIG_HASH[1:]])
            (self.root / 'config-hash.stdout.log').write_bytes(hash_raw)
            config_hash = hash_line(hash_raw)
            self.invoke([*self.fixture_files, 'create', '--no-build', '--pull', 'never', 'bellteam'], 'create-projection')
            projection = self.created(self.invoke([*self.fixture_files, 'ps', '--all', '-q', 'bellteam']),
                                      self.project + '-projection', 'projection', 11)
            projection_id = projection['id']
            self.inspect(projection, 'created')
            self.phase('projection-start', 11)
            self.invoke(['start', '-a', projection_id], 'start-projection')
            projection['status'] = 'exited'
            raw = self.invoke(['inspect', '--type', 'container', '--format', INSPECT_TEMPLATE, projection_id])
            (self.root / 'product-projection.stdout.log').write_bytes(raw)
            item = json.loads(raw)
            expected = {'id', 'name', 'imageId', 'imageRef', 'project', 'service', 'configHash', 'status', 'health', 'startedAt', 'restartCount'}
            if (type(item) is not dict or set(item) != expected or item['id'] != projection_id
                or item['name'] != '/' + projection['name'] or item['imageId'] != self.contract['amd64Config']
                or item['imageRef'] != IMAGE or item['project'] != self.project or item['service'] != 'bellteam'
                or item['configHash'] != config_hash or item['status'] != 'exited'
                or type(item['restartCount']) is not int or item['restartCount'] != 0
                or type(item['health']) is not str or not item['health'] or type(item['startedAt']) is not str or not item['startedAt']):
                raise Refused('CI_PRODUCT_PROJECTION_REPRESENTATION')
            self.remove(projection)
        except Exception as error:
            self.held = True
            self.state['failure'] = {'type': type(error).__name__, 'code': error.code if isinstance(error, ContractError) else 'CI_HELD'}
        try:
            self.cleanup()
        except Exception as error:
            self.state['cleanup'] = 'incomplete_' + type(error).__name__
            self.held = True
        self.state['residual'] = {'containers': [h for h in self.helpers if h['status'] != 'removed'],
                                  'volume': self.volume if self.volume_may_exist else None,
                                  'network': self.network if self.network_expected else None,
                                  'unknownNames': self.state['expectedNames'] if self.unknown else []}
        self.state.update(complete=not self.held and not self.unknown and self.state.get('cleanup') == 'complete', endedAt=utc())
        self.save()
        return 0 if self.state['complete'] else 1


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--contract', type=Path, required=True)
    args = parser.parse_args()
    if args.contract.resolve() != HERE / 'contract.json':
        raise Refused('CI_CONTRACT_LOCATION')
    contract = json.loads(args.contract.read_text())
    if (os.environ.get('GITHUB_REPOSITORY') != 'kitepon/BellTeam' or os.environ.get('GITHUB_EVENT_NAME') != 'workflow_dispatch'
        or os.environ.get('GITHUB_REF') != 'refs/heads/' + contract['branch'] or os.environ.get('GITHUB_RUN_ATTEMPT') != '1'
        or os.environ.get('CI_RUNNER_ENVIRONMENT') != 'github-hosted' or platform.system() != 'Linux'
        or platform.machine() != 'x86_64' or not Path('/sys/fs/cgroup/cgroup.controllers').exists()):
        raise Refused('CI_DEDICATED_NATIVE_VM_REQUIRED')
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=HERE).decode().strip()
    if head != os.environ.get('GITHUB_SHA') or contract['image'] != IMAGE:
        raise Refused('CI_HEAD_IMAGE_BINDING')
    for name, expected in json.loads((HERE / 'source-manifest.json').read_text()).items():
        if digest((HERE / name).read_bytes()) != expected:
            raise Refused('CI_SOURCE_SHA')
    for name, expected in contract['pins'].items():
        if digest((HERE / name).read_bytes()) != expected:
            raise Refused('CI_PIN_SHA')
    harness = Harness(HERE / 'output', contract)
    harness.state['workflowSourceHead'] = head
    harness.state['sourceManifestSHA256'] = digest((HERE / 'source-manifest.json').read_bytes())
    harness.save()
    return harness.run()


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Refused as error:
        print(error.code)
        raise SystemExit(2)
