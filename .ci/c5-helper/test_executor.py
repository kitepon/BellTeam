"""Only the new CI driver boundary; Docker/CLI/provider execution is artificial."""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import accept_helpers as driver
from c5_contract import ContractError


class Child:
    pid = os.getpid()

    def __init__(self, exit_code=0, timeout=False):
        self.exit_code, self.timeout = exit_code, timeout

    def wait(self, timeout=None):
        if self.timeout and timeout is not None:
            raise subprocess.TimeoutExpired('synthetic Docker', timeout)
        return self.exit_code

    def poll(self):
        return None if self.timeout else self.exit_code


class FakeDocker:
    def __init__(self):
        self.calls, self.containers, self.volumes, self.networks = [], {}, {}, {}
        self.counter = 0
        self.bad_cursor_cmd = False
        self.bad_caps = False
        self.start_timeout = False
        self.running_after_attach = False
        self.runner = None

    def item(self, ordinal, name, kind, asset=None):
        self.counter += 1
        item = {'Id': f'{self.counter:064x}', 'Name': '/' + name,
                'Image': self.runner.contract['amd64Config'],
                'Config': {'Image': driver.IMAGE, 'Labels': {'c5.run': self.runner.state['run'], 'c5.ordinal': str(ordinal)},
                           'Entrypoint': ['/bin/cat'], 'Cmd': [asset]},
                'HostConfig': {'NanoCpus': 1_000_000_000, 'Memory': 2 * driver.GIB, 'MemorySwap': 2 * driver.GIB,
                               'PidsLimit': 512, 'ReadonlyRootfs': True, 'NetworkMode': 'none'},
                'Mounts': [], 'State': {'Status': 'created', 'Running': False, 'Pid': 0, 'ExitCode': 0, 'OOMKilled': False}}
        if kind == 'cursor':
            item['Config'].update({'User': '1000:1000', 'Entrypoint': ['/usr/local/bin/bellteam-update-cursor'],
                                   'Cmd': None if self.bad_cursor_cmd else []})
            item['HostConfig'].update({'NetworkMode': self.runner.network, 'Init': True, 'CapDrop': ['ALL'],
                                      'SecurityOpt': ['no-new-privileges:true'], 'Tmpfs': {'/tmp': 'exec,size=512m', '/home/bell': 'uid=1000,gid=1000,mode=0700,size=64m'}})
            item['Mounts'] = [{'Type': 'volume', 'Name': self.runner.volume, 'Destination': '/home/bell/.local',
                               'RW': True, 'Source': '/synthetic/docker/volume', 'Driver': 'local', 'Mode': 'rw', 'Propagation': ''}]
        if self.bad_caps:
            item['HostConfig']['MemorySwap'] = -1
        self.containers[item['Id']] = item
        return item

    def __call__(self, argv, **kwargs):
        assert argv[0] == 'docker'
        args = argv[1:]
        self.calls.append(args)
        assert not any(key in kwargs['env'] for key in ['GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'DOCKER_HOST'])
        data = self.answer(args)
        timeout = self.start_timeout and args[:2] == ['start', '-a']
        kwargs['stdout'].write(data)
        kwargs['stdout'].flush()
        return Child(timeout=timeout)

    def answer(self, args):
        r = self.runner
        if args[0] == 'version' or args[:2] == ['compose', 'version']:
            return b'{}'
        if args[0] == 'info':
            return json.dumps({'DockerRootDir': '/synthetic/docker', 'OSType': 'linux', 'Architecture': 'x86_64'}).encode()
        if args[0] == 'pull':
            return b'synthetic pull'
        if args[:2] == ['image', 'inspect']:
            return json.dumps([{'Id': r.contract['amd64Config'], 'Architecture': 'amd64',
                                'Config': {'Labels': {'org.opencontainers.image.revision': r.contract['source']}}}]).encode()
        if args[0] == 'create':
            labels = [args[i + 1] for i, value in enumerate(args) if value == '--label']
            ordinal = int(next(value.split('=', 1)[1] for value in labels if value.startswith('c5.ordinal=')))
            item = self.item(ordinal, args[args.index('--name') + 1], 'asset', args[-1])
            return item['Id'].encode()
        if args[0] == 'inspect':
            return json.dumps([self.containers[args[1]]]).encode()
        if args[:2] == ['start', '-a']:
            item = self.containers[args[2]]
            item['State'].update({'Status': 'running' if self.running_after_attach else 'exited',
                                  'Running': self.running_after_attach, 'Pid': 123 if self.running_after_attach else 0})
            if item['Config']['Entrypoint'] == ['/bin/cat']:
                return (driver.HERE / 'assets' / item['Config']['Cmd'][0].removeprefix('/app/')).read_bytes()
            return b'synthetic official update'
        if args[0] == 'rm':
            assert args[1] in self.containers and self.containers[args[1]]['State']['Running'] is False
            del self.containers[args[1]]
            return b'removed'
        if args[:2] == ['container', 'ls']:
            selected = next(value for value in args if value.startswith(('id=', 'volume=')))
            if selected.startswith('id='):
                return selected[3:].encode() if selected[3:] in self.containers else b''
            return b'\n'.join(key.encode() for key, item in self.containers.items() if item['Mounts'])
        if args[0] in ('volume', 'network'):
            table = self.volumes if args[0] == 'volume' else self.networks
            if args[1] == 'ls':
                pattern = next(value for value in args if value.startswith('name='))[5:]
                return b'\n'.join(name.encode() for name in table if pattern.strip('^$') == name)
            if args[1] == 'create':
                assert args[0] == 'volume' and args[-1] not in table
                table[args[-1]] = {'Name': args[-1], 'Driver': 'local', 'Options': None, 'Labels': {'c5.run': r.state['run']}}
                return args[-1].encode()
            if args[1] == 'inspect':
                return json.dumps([table[args[-1]]]).encode()
            if args[1] == 'rm':
                name = next((name for name, item in table.items() if item.get('Id') == args[-1]), args[-1])
                del table[name]
                return b'removed'
        if args[0] == 'compose':
            if 'config' in args:
                return json.dumps({'services': {'cursor-update': {'image': driver.IMAGE}},
                                   'volumes': {'cursor-cli': {'name': r.volume, 'external': True}},
                                   'networks': {'default': {'name': r.network}}}).encode()
            if 'create' in args:
                self.item(8, r.project + '-cursor-update-1', 'cursor')
                self.networks[r.network] = {'Name': r.network, 'Id': 'f' * 64, 'Driver': 'bridge',
                                            'Labels': {'com.docker.compose.project': r.project}, 'Containers': {}}
                return b''
            if 'ps' in args:
                return next(key for key, item in self.containers.items() if item['Mounts']).encode()
        raise AssertionError(args)


class ArtificialRunner(driver.Runner):
    def observe(self, helper, stop):
        # CI driver sequencing only; not a measurement of a real runtime cgroup.
        helper['cgroup'] = {'status': 'observed', 'samples': [{'synthetic': True}]}


class ExecutorBoundary(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.clock = 100.0
        self.contract = json.loads((driver.HERE / 'contract.json').read_text())
        self.fake = FakeDocker()
        self.runner = ArtificialRunner(Path(self.temporary.name) / 'output', self.contract,
                                       clock=lambda: self.clock, probe=self.probe, spawn=self.fake, epoch='centi-ci-artificial')
        self.fake.runner = self.runner

    def probe(self):
        return {'at': self.clock, 'mem': 12 * driver.GIB, 'free': 50 * driver.GIB}

    def execute(self):
        def advance(seconds):
            self.clock += seconds
        with patch.object(driver.time, 'sleep', advance):
            return self.runner.execute()

    def test_normal_exact_three_helpers_and_dedicated_cleanup(self):
        self.assertEqual(self.execute(), 0)
        self.assertTrue(self.runner.state['complete'])
        self.assertEqual(len(self.runner.state['containers']), 3)
        self.assertTrue(all(item['status'] == 'removed' for item in self.runner.state['containers']))
        self.assertFalse(self.fake.containers or self.fake.volumes or self.fake.networks)
        self.assertEqual(sum(args[0] == 'start' for args in self.fake.calls), 3)
        # Thirteen explicit calls plus the network implicitly created by Compose.
        self.assertEqual(len(self.runner.state['claims']), 13)
        self.assertEqual(len(self.runner.state['claims']) + 1, 14)
        self.assertTrue(all(args[0] not in ['exec', 'run', 'stop', 'kill', 'build', 'tag', 'push', 'system'] for args in self.fake.calls))
        self.assertTrue((self.runner.root / 'inspect-8-created.json').exists())

    def test_created_hostconfig_mismatch_never_starts(self):
        self.fake.bad_caps = True
        self.assertEqual(self.execute(), 1)
        self.assertFalse(any(args[0] == 'start' for args in self.fake.calls))
        self.assertFalse(self.fake.containers)

    def test_real_no_argument_cmd_preserves_raw_and_rejects_invalid_arguments(self):
        path = driver.HERE / 'fixtures/real-inspect-24394.json'
        raw = path.read_bytes()
        plan = json.loads((driver.HERE / 'fixtures/real-inspect-24394-plan.json').read_text())
        case = plan['case']
        def validate(content):
            return driver.validate_inspect_json(content, plan, case['id'], case['name'], case['ordinal'],
                                                case['expected_status'], case['kind'])
        self.assertIsNone(validate(raw)['Config']['Cmd'])
        for value in [[], ['unexpected'], '', 'unexpected', {}, False, True, 0, 1]:
            with self.subTest(command=value):
                derived = json.loads(raw)
                derived[0]['Config']['Cmd'] = value
                if type(value) is list and not value:
                    self.assertEqual(validate(json.dumps(derived).encode())['Config']['Cmd'], [])
                else:
                    with self.assertRaisesRegex(ContractError, 'C5_HELPER_CURSOR_IDENTITY_MISMATCH'):
                        validate(json.dumps(derived).encode())
        self.assertEqual(path.read_bytes(), raw)
        self.assertFalse(self.fake.calls)

    def test_timeout_unknown_never_retries_or_cleans_up_unknown_resources(self):
        self.fake.start_timeout = True
        self.assertEqual(self.execute(), 1)
        self.assertTrue(self.runner.unknown)
        before = len(self.fake.calls)
        with self.assertRaises(driver.Refused):
            self.runner.command(['pull', driver.IMAGE], effect='second-pull')
        self.assertEqual(len(self.fake.calls), before)
        self.assertFalse(any(args[0] == 'rm' for args in self.fake.calls))
        self.assertEqual(len(self.fake.containers), 1)

    def test_running_container_is_not_force_removed(self):
        self.fake.running_after_attach = True
        self.assertEqual(self.execute(), 1)
        self.assertFalse(any(args[0] == 'rm' for args in self.fake.calls))
        self.assertFalse(self.runner.state['complete'])

    def test_postclaim_deadline_refuses_spawn(self):
        self.runner.phase('pull')
        calls = 0
        def delayed():
            nonlocal calls
            calls += 1
            if calls == 2:
                self.clock += 301
            return self.probe()
        self.runner.probe = delayed
        with self.assertRaises(driver.Refused):
            self.runner.command(['pull', driver.IMAGE], effect='pull')
        self.assertFalse(self.fake.calls)
        self.assertTrue((self.runner.root / 'pull.claim').exists())

    def test_postclaim_resource_loss_refuses_spawn(self):
        self.runner.phase('pull')
        calls = 0
        def pressure():
            nonlocal calls
            calls += 1
            result = self.probe()
            if calls == 2:
                result['mem'] = 3 * driver.GIB
            return result
        self.runner.probe = pressure
        with self.assertRaises(driver.Refused):
            self.runner.command(['pull', driver.IMAGE], effect='pull')
        self.assertFalse(self.fake.calls)

    def test_receipt_io_delay_is_rechecked_immediately_before_spawn(self):
        self.runner.phase('pull')
        calls = 0
        def delayed_after_receipt():
            nonlocal calls
            calls += 1
            if calls == 3:
                self.clock += 301
            return self.probe()
        self.runner.probe = delayed_after_receipt
        with self.assertRaises(driver.Refused):
            self.runner.command(['pull', driver.IMAGE], effect='pull')
        self.assertFalse(self.fake.calls)
        self.assertEqual(self.runner.state['commands'][0]['outcome'], 'not_spawned_guard')

    def test_one_claim_never_issues_twice(self):
        self.runner.phase('pull')
        self.runner.command(['pull', driver.IMAGE], effect='pull')
        with self.assertRaises(FileExistsError):
            self.runner.command(['pull', driver.IMAGE], effect='pull')
        self.assertEqual(len(self.fake.calls), 1)

    def test_stale_resource_and_insufficient_whole_budget_refuse(self):
        self.runner.phase('pull')
        self.runner.probe = lambda: {**self.probe(), 'at': self.clock - 4}
        with self.assertRaises(driver.Refused):
            self.runner.command(['pull', driver.IMAGE], effect='pull')
        self.assertFalse(self.fake.calls)
        self.clock = self.runner.end - 399
        with self.assertRaises(driver.Refused):
            self.runner.phase('pull')

    def test_wrong_owner_never_removed(self):
        item = self.fake.item(2, 'synthetic-foreign', 'asset', '/app/compose.cursor-update.yaml')
        helper = {'id': item['Id'], 'name': 'synthetic-foreign', 'ordinal': 2, 'status': 'created'}
        item['Config']['Labels']['c5.run'] = 'foreign'
        self.runner.phase('cleanup', cleanup=True)
        with self.assertRaises(driver.Refused):
            self.runner.remove_helper(helper)
        self.assertFalse(any(args[0] == 'rm' for args in self.fake.calls))

    def test_cgroup_swap_or_oom_is_rejected_without_substitution(self):
        sample = {'memory.max': str(2 * driver.GIB), 'memory.swap.max': '0', 'cpu.max': '100000 100000',
                  'pids.max': '512', 'memory.events': 'oom 0\noom_kill 0'}
        driver.check_cgroup(sample)
        for change in [{'memory.swap.max': 'max'}, {'cpu.max': '200000 100000'}, {'memory.events': 'oom 1\noom_kill 0'}]:
            with self.subTest(change=change), self.assertRaises(driver.Refused):
                driver.check_cgroup({**sample, **change})

    def test_non_ci_entry_refuses_before_docker(self):
        with patch.dict(os.environ, {}, clear=True), patch('sys.argv', ['accept_helpers.py', '--contract', str(driver.HERE / 'contract.json')]):
            with self.assertRaises(driver.Refused):
                driver.main()
        self.assertFalse(self.fake.calls)

    def test_observer_hold_cannot_be_reported_as_complete(self):
        def held_observer(helper, stop):
            helper['cgroup'] = {'status': 'observed', 'samples': [{'synthetic': True}]}
            self.runner.held = True
        self.runner.observe = held_observer
        self.assertEqual(self.execute(), 1)
        self.assertFalse(self.runner.state['complete'])
        self.assertEqual(sum(args[0] == 'start' for args in self.fake.calls), 1)

    def test_invalid_created_cid_is_unknown_without_cleanup_mutations(self):
        original = self.fake.answer
        def malformed(args):
            raw = original(args)
            return b'not-a-container-id' if args[0] == 'create' else raw
        self.fake.answer = malformed
        self.assertEqual(self.execute(), 1)
        self.assertTrue(self.runner.unknown)
        self.assertFalse(any(args[0] == 'rm' for args in self.fake.calls))

    def test_compose_create_uses_supported_create_options(self):
        original = self.fake.answer
        def create_parser(args):
            if args[0] == 'compose' and 'create' in args:
                self.assertNotIn('--no-deps', args, 'real Compose create rejects the run-only --no-deps flag')
                self.assertEqual(args[args.index('create'):], ['create', '--no-build', '--pull', 'never', '--no-recreate', 'cursor-update'])
            return original(args)
        self.fake.answer = create_parser
        self.runner.phase('volumePrepare')
        self.runner.prepare_volume()
        self.runner.phase('cursorCreateAndValidate')
        helper = self.runner.create_cursor()
        self.assertEqual(helper['ordinal'], 8)
        self.assertFalse(any(args[0] == 'start' for args in self.fake.calls))


if __name__ == '__main__':
    unittest.main()
