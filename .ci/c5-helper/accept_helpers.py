"""One fresh GitHub VM, fixed image, two cat helpers and one Cursor helper."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from c5_inspect_contract import validate_inspect_json

HERE = Path(__file__).resolve().parent
GIB = 1024 ** 3
IMAGE = 'ghcr.io/kitepon/bellteam-server@sha256:c5a20bd36a8f3ee3fd6e7f23872931125e159a45baf7e01a56185fbb7c5e4c2e'
CAPS = {'nano_cpus': 1_000_000_000, 'memory_bytes': 2 * GIB,
        'memory_swap_bytes': 2 * GIB, 'pids_limit': 512}


class Refused(Exception):
    pass


def utc():
    return datetime.now(timezone.utc).isoformat()


def ticks(pid):
    try:
        return int(Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()[19])
    except (OSError, ValueError, IndexError):
        return None


def put(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    os.replace(temporary, path)


def cid(raw):
    value = raw.decode().strip()
    if not re.fullmatch('[0-9a-f]{64}', value):
        raise Refused('CID_INVALID')
    return value


def check_cgroup(sample):
    try:
        quota, period = map(int, sample['cpu.max'].split())
        events = dict(line.split() for line in sample['memory.events'].splitlines())
        valid = (sample['memory.max'] == str(2 * GIB) and sample['memory.swap.max'] == '0'
                 and sample['pids.max'] == '512' and quota == period and period > 0
                 and int(events['oom']) == 0 and int(events['oom_kill']) == 0)
    except (KeyError, ValueError, TypeError):
        raise Refused('CGROUP_INCOMPLETE') from None
    if not valid:
        raise Refused('ACTUAL_CGROUP_LIMITS_OR_OOM')


class Runner:
    def __init__(self, root, contract, *, clock=time.monotonic, probe=None, spawn=subprocess.Popen, epoch=None):
        self.root, self.contract = Path(root), contract
        self.root.mkdir(mode=0o700, parents=True, exist_ok=False)
        self.clock, self.spawn = clock, spawn
        self.probe = probe or self.resources
        self.docker_root = Path('/var/lib/docker')
        self.start = self.clock()
        self.end = self.start + contract['scriptSeconds']
        self.phase_end = self.start
        self.initial_free = None
        self.unknown = False
        self.held = False
        self.cleanup_mode = False
        self.lock = threading.RLock()
        self.state = {'run': epoch or f"centi-c5-helper-{os.environ.get('GITHUB_RUN_ID', 'local')}-1-{uuid.uuid4().hex[:12]}",
                      'image': IMAGE, 'startedAt': utc(), 'phase': None, 'commands': [],
                      'containers': [], 'claims': [], 'phaseEvents': [], 'unknown': False, 'complete': False,
                      'expectedSource': contract['source'], 'expectedAmd64Manifest': contract['amd64Manifest'],
                      'expectedAmd64Config': contract['amd64Config']}
        self.project = self.state['run']
        self.volume = self.project + '-cursor'
        self.network = self.project + '_default'
        self.state['resourceNames'] = {'volume': self.volume, 'network': self.network,
                                       'containers': [self.project + '-asset-2', self.project + '-asset-3', self.project + '-cursor-update-1']}
        self.volume_owned = False
        self.network_expected = False
        self.plan = {'image': IMAGE, 'run': self.state['run'], 'helper_caps': CAPS,
                     'cursor_volume': self.volume, 'cursor_network_mode': self.network}
        home = self.root / 'empty-home'
        config = self.root / 'empty-docker-config'
        home.mkdir(mode=0o700); config.mkdir(mode=0o700)
        self.env = {'PATH': os.environ['PATH'], 'HOME': str(home), 'DOCKER_CONFIG': str(config),
                    'BELLTEAM_CURSOR_UPDATE_IMAGE': IMAGE, 'BELLTEAM_CURSOR_VOLUME': self.volume,
                    'C5_EPOCH': self.state['run'], 'C5_ORDINAL': '8'}
        self.save()

    def save(self):
        with self.lock:
            self.state['updatedAt'] = utc()
            self.state['unknown'] = self.unknown
            self.state['held'] = self.held
            put(self.root / 'state.json', self.state)

    def resources(self):
        memory = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
        fs = os.statvfs(self.docker_root)
        return {'at': self.clock(), 'mem': int(memory['MemAvailable'].split()[0]) * 1024,
                'free': fs.f_bavail * fs.f_frsize, 'utc': utc()}

    def resource_check(self, initial=False):
        sample = self.probe()
        age = self.clock() - sample['at']
        if not 0 <= age <= 3 or any(type(sample[k]) is not int for k in ('mem', 'free')):
            raise Refused('RESOURCE_MISSING_OR_STALE')
        if sample['mem'] < (8 if initial else 4) * GIB or sample['free'] < (24 if initial else 8) * GIB:
            raise Refused('RESOURCE_HEADROOM')
        if self.initial_free is not None and self.initial_free - sample['free'] > 16 * GIB:
            raise Refused('DISK_GROWTH')
        self.state['lastResources'] = sample
        return sample

    def phase(self, name, cleanup=False):
        now = self.clock()
        seconds = self.contract['phaseSeconds'][name]
        reserve = 0 if cleanup else self.contract['cleanupSeconds'] + self.contract['decisionSeconds']
        if now + seconds + reserve > self.end:
            raise Refused('PHASE_BUDGET')
        if not cleanup and (self.unknown or self.held):
            raise Refused('LATCHED')
        self.cleanup_mode = cleanup
        self.phase_end = now + seconds
        self.state['phase'] = name
        self.state['phaseEvents'].append({'phase': name, 'startUTC': utc(), 'monotonicDeadline': self.phase_end})
        self.save()

    def budget(self):
        reserve = 0 if self.cleanup_mode else self.contract['cleanupSeconds'] + self.contract['decisionSeconds']
        remaining = min(self.phase_end, self.end - reserve) - self.clock()
        if remaining <= 0:
            raise Refused('PRESPAWN_DEADLINE')
        return remaining

    def claim(self, action):
        if not re.fullmatch('[a-z0-9-]+', action):
            raise Refused('CLAIM_NAME')
        with (self.root / (action + '.claim')).open('x') as stream:
            os.chmod(stream.name, 0o600)
            receipt = {'action': action, 'run': self.state['run'], 'at': utc()}
            json.dump(receipt, stream)
            stream.flush(); os.fsync(stream.fileno())
        self.state['claims'].append(receipt)
        self.save()

    def command(self, argv, *, effect=None, allow_nonzero=False, hook=None):
        if self.unknown:
            raise Refused('OUTCOME_UNKNOWN')
        if effect and self.held and not self.cleanup_mode:
            raise Refused('LATCHED')
        try:
            self.budget()
            self.resource_check()
            if effect:
                self.claim(effect)
            # Claim and resource I/O consume time: check again immediately before spawn.
            self.resource_check()
            remaining = self.budget()
        except (OSError, KeyError, Refused, ValueError):
            self.held = True
            self.save()
            raise
        with self.lock:
            index = len(self.state['commands'])
            record = {'index': index, 'argv': argv, 'effect': effect, 'phase': self.state['phase'], 'startUTC': utc(), 'outcome': 'prepared'}
            self.state['commands'].append(record)
        stdout_path = self.root / f'{index:03d}.stdout.log'
        stderr_path = self.root / f'{index:03d}.stderr.log'
        output, error = stdout_path.open('wb'), stderr_path.open('wb')
        child = None
        stop_sampling, sampler = threading.Event(), None
        try:
            try:
                # Receipt/output setup is also I/O; its time must not escape the final guard.
                self.resource_check()
                remaining = self.budget()
            except (OSError, KeyError, Refused, ValueError):
                self.held = True
                with self.lock:
                    record['outcome'] = 'not_spawned_guard'
                raise
            try:
                child = self.spawn(['docker', *argv], stdin=subprocess.DEVNULL, stdout=output,
                                   stderr=error, env=self.env)
            except OSError:
                self.unknown = bool(effect)
                with self.lock:
                    record['outcome'] = 'spawn_unknown'
                raise Refused('SPAWN_UNKNOWN' if effect else 'READ_SPAWN_FAILED') from None
            with self.lock:
                record.update({'pid': child.pid, 'startTicks': ticks(child.pid)})
            self.save()
            if hook:
                sampler = threading.Thread(target=hook, args=(stop_sampling,), daemon=True)
                sampler.start()
            try:
                exit_code = child.wait(timeout=remaining)
            except subprocess.TimeoutExpired:
                self.unknown = True
                with self.lock:
                    record['outcome'] = 'unknown_timeout'
                # Keep the already issued client/daemon untouched; no communicate()/kill/retry.
                def reap():
                    child.wait(); output.close(); error.close()
                threading.Thread(target=reap, daemon=True).start()
                raise Refused('CLIENT_OUTCOME_UNKNOWN') from None
            with self.lock:
                record.update({'exitCode': exit_code, 'endUTC': utc(), 'outcome': 'finished'})
            if exit_code and not allow_nonzero:
                self.unknown = bool(effect)
                self.held = True
                raise Refused('MUTATION_OUTCOME_UNKNOWN' if effect else 'DOCKER_READ_FAILED')
        finally:
            stop_sampling.set()
            if sampler:
                sampler.join(timeout=2)
                if sampler.is_alive():
                    self.unknown = True
            if child is None or child.poll() is not None:
                output.close(); error.close()
            self.save()
        if max(stdout_path.stat().st_size, stderr_path.stat().st_size) > 2 * 1024 * 1024:
            self.held = True
            raise Refused('OUTPUT_LIMIT')
        return stdout_path.read_bytes(), exit_code

    def inspect(self, helper, status):
        raw, _ = self.command(['inspect', helper['id']])
        (self.root / f"inspect-{helper['ordinal']}-{status}.json").write_bytes(raw)
        item = validate_inspect_json(raw, self.plan, helper['id'], helper['name'], helper['ordinal'],
                                     status, helper['kind'], helper.get('asset'))
        if item['Image'] != self.contract['amd64Config']:
            raise Refused('IMAGE_CONFIG_MISMATCH')
        return item

    def observe(self, helper, stop):
        observation = {'status': 'not_observed', 'samples': []}
        with self.lock:
            helper['cgroup'] = observation
        try:
            item = None
            for _ in range(5):
                if stop.is_set() or self.unknown:
                    return
                raw, _ = self.command(['inspect', helper['id']])
                found = json.loads(raw)
                if len(found) != 1 or found[0]['Id'] != helper['id']:
                    raise Refused('SAMPLER_IDENTITY')
                item = found[0]
                if item['State']['Running'] is True and item['State']['Pid'] > 0:
                    break
                if stop.wait(0.2):
                    return
            else:
                return
            pid = item['State']['Pid']
            start = ticks(pid)
            if start is None:
                return
            with self.lock:
                helper.update({'runtimeHostPid': pid, 'runtimeStartTicks': start})
            lines = Path(f'/proc/{pid}/cgroup').read_text().splitlines()
            rel = next(line[3:] for line in lines if line.startswith('0::'))
            cgroup = (Path('/sys/fs/cgroup') / rel.lstrip('/')).resolve()
            if not cgroup.is_relative_to('/sys/fs/cgroup'):
                raise Refused('CGROUP_PATH')
            with self.lock:
                observation['path'] = str(cgroup)
            while not stop.is_set():
                if ticks(pid) != start:
                    break
                sample = {'at': utc()}
                for name in ['memory.max', 'memory.swap.max', 'cpu.max', 'pids.max', 'memory.peak', 'memory.events']:
                    sample[name] = (cgroup / name).read_text().strip()
                check_cgroup(sample)
                with self.lock:
                    observation['samples'].append(sample)
                    observation['status'] = 'observed'
                self.resource_check()
                self.save()
                stop.wait(1)
        except (OSError, ValueError, KeyError, IndexError, StopIteration, Refused) as error:
            with self.lock:
                observation['error'] = type(error).__name__
            # A vanished terminal cgroup is missing evidence, not a zero peak/OOM.
            if isinstance(error, Refused):
                self.held = True
        finally:
            self.save()

    def start_helper(self, helper):
        self.inspect(helper, 'created')
        raw, _ = self.command(['start', '-a', helper['id']], effect=f"start-{helper['ordinal']}",
                              hook=lambda stop: self.observe(helper, stop))
        item = self.inspect(helper, 'exited')
        if item['State']['ExitCode'] != 0 or item['State']['OOMKilled'] is not False:
            raise Refused('HELPER_EXIT_OR_OOM')
        if helper['kind'] == 'cursor' and helper.get('cgroup', {}).get('status') != 'observed':
            raise Refused('CURSOR_CGROUP_UNOBSERVED')
        if self.held:
            raise Refused('OBSERVATION_GUARD_HELD')
        helper['status'] = 'exited'
        return raw

    def owned_stopped(self, item, helper):
        return (item.get('Id') == helper['id'] and item.get('Name') == '/' + helper['name']
                and item.get('Image') == self.contract['amd64Config']
                and item.get('Config', {}).get('Image') == IMAGE
                and item.get('Config', {}).get('Labels', {}).get('c5.run') == self.state['run']
                and item['Config']['Labels'].get('c5.ordinal') == str(helper['ordinal'])
                and item.get('State', {}).get('Status') in ('created', 'exited')
                and item['State'].get('Running') is False and item['State'].get('Pid') == 0)

    def remove_helper(self, helper):
        raw, _ = self.command(['inspect', helper['id']])
        items = json.loads(raw)
        if len(items) != 1 or not self.owned_stopped(items[0], helper):
            raise Refused('CLEANUP_NOT_KNOWN_STOPPED')
        self.command(['rm', helper['id']], effect=f"rm-{helper['ordinal']}")
        remaining, _ = self.command(['container', 'ls', '--all', '--no-trunc', '--filter',
                                     'id=' + helper['id'], '--format', '{{.ID}}'])
        if remaining.strip():
            raise Refused('CONTAINER_REMAINS')
        helper['status'] = 'removed'
        self.save()

    def asset(self, ordinal, name, path):
        helper = {'ordinal': ordinal, 'name': self.project + f'-asset-{ordinal}', 'kind': 'asset', 'asset': path}
        raw, _ = self.command(['create', '--name', helper['name'], '--label', 'c5.run=' + self.state['run'],
                              '--label', 'c5.ordinal=' + str(ordinal), '--cpus', '1', '--memory', '2g',
                              '--memory-swap', '2g', '--pids-limit', '512', '--pull', 'never',
                              '--network', 'none', '--read-only', '--entrypoint', '/bin/cat', IMAGE, path],
                             effect=f'create-{ordinal}')
        try:
            helper.update({'id': cid(raw), 'status': 'created'})
        except Refused:
            self.unknown = True
            raise
        self.state['containers'].append(helper); self.save()
        content = self.start_helper(helper)
        if hashlib.sha256(content).hexdigest() != self.contract['pins']['assets/' + name]:
            raise Refused('ASSET_SHA')
        destination = self.root / 'assets' / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
        self.remove_helper(helper)

    def compose(self):
        return ['compose', '-p', self.project, '-f', str(self.root / 'assets/compose.cursor-update.yaml'),
                '-f', str(HERE / 'cursor-caps.overlay.yaml')]

    def cursor_config(self):
        raw, _ = self.command([*self.compose(), 'config', '--format', 'json'])
        (self.root / 'compose-config.json').write_bytes(raw)
        config = json.loads(raw)
        services = config['services']
        if set(services) != {'cursor-update'}:
            raise Refused('COMPOSE_SERVICES')
        service = services['cursor-update']
        if service['image'] != IMAGE or any(service.get(k) for k in ['environment', 'env_file', 'secrets', 'configs', 'ports', 'devices', 'privileged', 'pid', 'ipc']):
            raise Refused('COMPOSE_EXTRA_ACCESS')
        volumes = config['volumes']
        if set(volumes) != {'cursor-cli'} or volumes['cursor-cli']['name'] != self.volume or volumes['cursor-cli']['external'] is not True:
            raise Refused('COMPOSE_VOLUME')
        if config['networks']['default']['name'] != self.network:
            raise Refused('COMPOSE_NETWORK')

    def prepare_volume(self):
        for kind, name in [('volume', self.volume), ('network', self.network)]:
            found, _ = self.command([kind, 'ls', '--filter', f'name=^{name}$', '--format', '{{.Name}}'])
            if found.strip():
                raise Refused('RESOURCE_NAME_ALREADY_EXISTS')
        self.command(['volume', 'create', '--label', 'c5.run=' + self.state['run'], self.volume], effect='volume-create')
        self.volume_owned = True
        self.volume_identity()

    def volume_identity(self):
        raw, _ = self.command(['volume', 'inspect', self.volume])
        values = json.loads(raw)
        if (len(values) != 1 or values[0]['Name'] != self.volume or values[0]['Driver'] != 'local'
            or values[0].get('Options') not in (None, {})
            or values[0]['Labels'].get('c5.run') != self.state['run']):
            raise Refused('VOLUME_IDENTITY')
        self.state['volumeIdentity'] = values[0]

    def create_cursor(self):
        self.volume_identity()
        # Compose creates its own unique default network; remember this possible effect before issuing it.
        self.network_expected = True
        self.command([*self.compose(), 'create', '--no-build', '--pull', 'never', '--no-recreate', 'cursor-update'], effect='create-8')
        try:
            raw, _ = self.command([*self.compose(), 'ps', '--all', '-q', 'cursor-update'])
            helper = {'id': cid(raw), 'name': self.project + '-cursor-update-1', 'ordinal': 8, 'kind': 'cursor', 'status': 'created'}
        except Exception:
            self.unknown = True
            raise
        self.state['containers'].append(helper); self.save()
        self.inspect(helper, 'created')
        return helper

    def cleanup(self):
        if self.unknown:
            with self.lock:
                self.state['cleanup'] = 'incomplete_unknown_no_new_mutation'
            self.save(); return
        self.phase('cleanup', cleanup=True)
        for helper in self.state['containers']:
            if helper['status'] != 'removed':
                self.remove_helper(helper)
        if self.volume_owned:
            self.volume_identity()
            users, _ = self.command(['container', 'ls', '--all', '--filter', 'volume=' + self.volume, '--format', '{{.ID}}'])
            if users.strip():
                raise Refused('VOLUME_STILL_REFERENCED')
            self.command(['volume', 'rm', self.volume], effect='volume-rm')
            remaining, _ = self.command(['volume', 'ls', '--filter', f'name=^{self.volume}$', '--format', '{{.Name}}'])
            if remaining.strip():
                raise Refused('VOLUME_REMAINS')
            self.volume_owned = False
        if self.network_expected:
            raw, _ = self.command(['network', 'inspect', self.network])
            values = json.loads(raw)
            if (len(values) != 1 or values[0]['Name'] != self.network or values[0]['Driver'] != 'bridge'
                or values[0]['Labels'].get('com.docker.compose.project') != self.project
                or values[0]['Containers'] != {}):
                raise Refused('NETWORK_NOT_KNOWN_OWNED_EMPTY')
            self.command(['network', 'rm', cid(values[0]['Id'].encode())], effect='network-rm')
            remaining, _ = self.command(['network', 'ls', '--filter', f'name=^{self.network}$', '--format', '{{.Name}}'])
            if remaining.strip():
                raise Refused('NETWORK_REMAINS')
            self.network_expected = False
        self.state['cleanup'] = 'complete'
        self.save()

    def execute(self):
        problem = None
        try:
            self.phase('preflight')
            for args in [['version', '--format', '{{json .}}'], ['compose', 'version', '--short']]:
                self.command(args)
            info, _ = self.command(['info', '--format', '{{json .}}'])
            metadata = json.loads(info)
            self.docker_root = Path(metadata['DockerRootDir'])
            if not self.docker_root.is_absolute() or metadata['OSType'] != 'linux' or metadata['Architecture'] not in ('x86_64', 'amd64'):
                raise Refused('DAEMON_IDENTITY')
            frames = self.state['initialResourceFrames'] = []
            for _ in range(4):
                sample = self.resource_check(initial=True)
                if frames and not 0 < sample['at'] - frames[-1]['at'] <= 2.5:
                    raise Refused('INITIAL_INTERVAL_INVALID')
                frames.append(sample)
                if self.initial_free is None:
                    self.initial_free = sample['free']
                if _ < 3:
                    time.sleep(1)
            self.phase('pull')
            self.command(['pull', '--platform', 'linux/amd64', IMAGE], effect='pull')
            raw, _ = self.command(['image', 'inspect', IMAGE])
            image = json.loads(raw)[0]
            if (image['Id'] != self.contract['amd64Config'] or image['Architecture'] != 'amd64'
                or image['Config']['Labels'].get('org.opencontainers.image.revision') != self.contract['source']):
                raise Refused('IMAGE_BINDING')
            self.phase('assetCompose'); self.asset(2, 'compose.cursor-update.yaml', '/app/compose.cursor-update.yaml')
            self.phase('assetUpdater'); self.asset(3, 'scripts/update-cursor.sh', '/app/scripts/update-cursor.sh')
            self.phase('composeConfig'); self.cursor_config()
            self.phase('volumePrepare'); self.prepare_volume()
            self.phase('cursorCreateAndValidate'); helper = self.create_cursor()
            self.phase('cursorStartObserveExit'); self.volume_identity(); self.start_helper(helper)
        except Exception as error:
            self.held = True
            problem = str(error) if isinstance(error, Refused) else type(error).__name__
            with self.lock:
                self.state['failure'] = problem
        try:
            self.cleanup()
        except Exception as error:
            self.state['cleanup'] = 'incomplete_' + type(error).__name__
            problem = problem or 'CLEANUP_INCOMPLETE'
        with self.lock:
            self.state['complete'] = not problem and not self.unknown and not self.held and self.state.get('cleanup') == 'complete'
            self.state['residual'] = {'containers': [item for item in self.state['containers'] if item['status'] != 'removed'],
                                  'volume': self.volume if self.volume_owned else None,
                                  'network': self.network if self.network_expected else None,
                                  'unknownClients': [item for item in self.state['commands'] if item.get('outcome') in ('unknown_timeout', 'spawn_unknown')],
                                  'unknownTargetNames': self.state['resourceNames'] if self.unknown else None}
            self.state['endedAt'] = utc()
        self.save()
        return 0 if self.state['complete'] else 1


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--contract', type=Path, required=True)
    args = parser.parse_args()
    if args.contract.resolve() != HERE / 'contract.json':
        raise Refused('CONTRACT_LOCATION')
    contract = json.loads(args.contract.read_text())
    if (os.environ.get('GITHUB_REPOSITORY') != 'kitepon/BellTeam'
        or os.environ.get('GITHUB_EVENT_NAME') != 'workflow_dispatch'
        or os.environ.get('GITHUB_REF') != 'refs/heads/' + contract['branch']
        or os.environ.get('GITHUB_RUN_ATTEMPT') != '1'
        or os.environ.get('CI_RUNNER_ENVIRONMENT') != 'github-hosted'
        or platform.system() != 'Linux' or platform.machine() != 'x86_64'
        or not Path('/sys/fs/cgroup/cgroup.controllers').exists()):
        raise Refused('DEDICATED_NATIVE_CI_REQUIRED')
    actual_head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=HERE).decode().strip()
    if actual_head != os.environ.get('GITHUB_SHA') or contract['image'] != IMAGE:
        raise Refused('SOURCE_BINDING')
    manifest = json.loads((HERE / 'source-manifest.json').read_text())
    for name, digest in manifest.items():
        if hashlib.sha256((HERE / name).read_bytes()).hexdigest() != digest:
            raise Refused('SOURCE_SHA')
    for name, digest in contract['pins'].items():
        if hashlib.sha256((HERE / name).read_bytes()).hexdigest() != digest:
            raise Refused('PIN_SHA')
    runner = Runner(HERE / 'output', contract)
    runner.state['workflowSourceHead'] = actual_head
    return runner.execute()


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Refused as error:
        print(str(error))
        raise SystemExit(2)
