"""New CI adapter boundaries only. No Docker or old artifact/helper suites."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import run as ci
from c5_state import write_state


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.now = 100.0
        self.sample = {'at': self.now, 'mem': 16 * ci.GIB, 'free': 64 * ci.GIB}
        self.contract = json.loads((ci.HERE / 'contract.json').read_text())
        self.h = ci.Harness(Path(self.temporary.name) / 'out', self.contract,
                            clock=lambda: self.now, probe=lambda: dict(self.sample, at=self.now), epoch='unit-ci')
        self.h.phase('preflight', 1)

    def environment(self):
        with patch.dict(ci.os.environ, self.h.input_env, clear=True):
            return ci.lower.helper_environment(self.h.plan, self.h.subject_path, 1)

    def active(self):
        self.h.active = {'argv': ['version', '--format', '{{.Client.Version}}'],
                         'seconds': 20, 'envOrdinal': 1, 'spawned': False}

    def test_final_guard_after_receipt_io_prevents_spawn(self):
        self.active()
        env = self.environment()
        original = self.h.save

        def delayed_save():
            original()
            self.now = self.h.phase_end + 1

        with patch.object(self.h, 'save', delayed_save):
            with self.assertRaisesRegex(ci.Refused, 'DEADLINE'):
                self.h.spawn_guard(['/usr/bin/docker', *self.h.active['argv']], env)
        self.assertNotIn('spawnAttemptedAt', self.h.active)

    def test_whole_call_and_reap_budget_is_required_at_spawn(self):
        self.active()
        self.now = self.h.phase_end - 20.5
        with self.assertRaisesRegex(ci.Refused, 'FULL_CALL_BUDGET'):
            self.h.spawn_guard(['/usr/bin/docker', *self.h.active['argv']], self.environment())
        self.assertNotIn('spawnAttemptedAt', self.h.active)

    def test_claim_io_expiry_and_replay_do_not_issue(self):
        original = self.h.claim

        def claim(name):
            original(name)
            self.now = self.h.phase_end + 1

        with patch.object(self.h, 'claim', claim), patch.object(ci.lower, '_run') as subject:
            with self.assertRaises(ci.Refused):
                self.h.invoke(['pull', '--quiet', '--platform', 'linux/amd64', ci.IMAGE], 'pull')
            subject.assert_not_called()
        self.assertTrue(self.h.held)
        with self.assertRaises(FileExistsError):
            original('pull')

    def test_transparent_pid_env_output_exit_and_terminal_before_reap(self):
        self.active()
        captures = []
        output, error = object(), object()

        class FakeProcess:
            def __init__(self, argv, **kwargs):
                captures.append(('spawn', argv, kwargs))
                self.pid, self.stdout, self.stderr, self.returncode = 43210, output, error, None

            def wait(self, *args, **kwargs):
                captures.append(('wait', args, kwargs))
                self.returncode = 7
                return 7

        env = self.environment()
        child = self.h.process_type(FakeProcess)(['/usr/bin/docker', *self.h.active['argv']], env=env, stdout=output, stderr=error)
        self.assertEqual(child.pid, 43210)
        self.assertIs(child.stdout, output)
        self.assertIs(child.stderr, error)
        self.assertIs(captures[0][2]['env'], env)
        with self.assertRaisesRegex(ci.Refused, 'WITHOUT_DURABLE'):
            child.wait(timeout=.125)
        self.assertEqual(len(captures), 1)
        self.h.subject['commands'] = [{'pid': child.pid, 'startTicks': 77,
                                       'phaseOrdinal': 1, 'endedAt': 'synthetic', 'terminal': {'kind': 'exit', 'status': 7}}]
        self.h.subject.update(helperClientPid=child.pid, helperClientStartTicks=77)
        write_state(self.h.subject_path, self.h.subject)
        self.assertEqual(child.wait(timeout=.125), 7)
        self.assertEqual(captures[-1], ('wait', (), {'timeout': .125}))
        self.assertEqual(self.h.state['reapTrace'][-1]['class'], 'terminal')

    def test_old_pid_generation_receipt_cannot_authorize_current_reap(self):
        self.h.subject.update(helperClientPid=43210, helperClientStartTicks=78,
                              commands=[{'pid': 43210, 'startTicks': 77, 'phaseOrdinal': 1,
                                         'endedAt': 'old', 'terminal': {'kind': 'exit', 'status': 0}}])
        write_state(self.h.subject_path, self.h.subject)
        with self.assertRaisesRegex(ci.Refused, 'WITHOUT_DURABLE'):
            self.h.reap_guard(43210)

    def test_unknown_blocks_every_next_Docker_and_cleanup(self):
        self.h.unknown = True
        with patch.object(ci.lower, '_run') as subject:
            with self.assertRaisesRegex(ci.Refused, 'LATCHED'):
                self.h.invoke(['version', '--format', '{{.Client.Version}}'])
            self.h.cleanup()
            subject.assert_not_called()
        self.assertIn('incomplete_unknown', self.h.state['cleanup'])

    def test_raw_representation_and_artifact_projection_do_not_hide_mismatch(self):
        self.assertEqual(ci.hash_line(b'bellteam ' + b'a' * 64 + b'\n'), 'a' * 64)
        for raw in [b'a' * 64, b'other ' + b'a' * 64, b'bellteam not-a-hash', b'bellteam ' + b'a' * 64 + b' extra']:
            with self.assertRaises(ci.Refused):
                ci.hash_line(raw)
        item = self.item()
        item['Config']['Env'] = ['SECRET=fake-marker']
        item['State']['Health'] = {'Status': 'healthy', 'Log': [{'Output': 'fake-marker'}]}
        item['Mounts'] = [{'Type': 'volume', 'Name': 'self', 'Source': '/private/fake-marker',
                           'Destination': '/home/bell/.local', 'RW': True}]
        self.assertNotIn('fake-marker', json.dumps(ci.public_helper(item)))
        self.assertNotIn('Env', ci.public_helper(item)['Config'])

    def item(self):
        return {'Id': 'a' * 64, 'Name': '/unit-ci-projection', 'Image': self.contract['amd64Config'],
                'Config': {'Image': ci.IMAGE, 'Labels': {'c5.run': 'unit-ci', 'c5.ordinal': '11'},
                           'User': '1000:1000', 'Entrypoint': ['/usr/local/bin/node'],
                           'Cmd': ['-e', 'setTimeout(()=>process.exit(0),5000)']},
                'HostConfig': {'ReadonlyRootfs': True, 'NanoCpus': 1_000_000_000, 'Memory': 2 * ci.GIB,
                               'MemorySwap': 2 * ci.GIB, 'PidsLimit': 512, 'NetworkMode': 'none',
                               'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges:true']},
                'State': {'Status': 'exited', 'Running': False, 'Pid': 0, 'ExitCode': 0, 'OOMKilled': False}, 'Mounts': []}

    def test_only_confirmed_owned_stopped_CID_can_be_removed(self):
        helper = self.h.remember('a' * 64, 'unit-ci-projection', 'projection', 11)
        helper['status'] = 'exited'
        for mutate in [lambda x: x['State'].update(Running=True), lambda x: x['State'].update(Pid=2),
                       lambda x: x.update(Name='/foreign'), lambda x: x['Config']['Labels'].update({'c5.run': 'foreign'})]:
            item = self.item()
            mutate(item)
            with patch.object(self.h, 'invoke', return_value=json.dumps([item]).encode()) as subject:
                with self.assertRaises(ci.Refused):
                    self.h.remove(helper)
                self.assertEqual(subject.call_args_list[0].args[0], ['inspect', helper['id']])
                self.assertEqual(subject.call_count, 1)
        calls = []

        def invoke(argv, *args, **kwargs):
            calls.append(argv)
            if argv[0] == 'inspect':
                return json.dumps([self.item()]).encode()
            if argv[0] == 'rm':
                self.h.allow_argv(argv)
            return b''

        with patch.object(self.h, 'invoke', invoke):
            self.h.remove(helper)
        self.assertEqual(helper['status'], 'removed')
        self.assertEqual(sum(argv[0] == 'rm' for argv in calls), 1)

    def test_no_cursor_start_unapproved_rm_unknown_CID_or_extra_access(self):
        helper = self.h.remember('a' * 64, 'unit-ci-cursor-update-1', 'cursor', 8)
        for argv in [['start', '-a', helper['id']], ['rm', helper['id']], ['stop', helper['id']],
                     ['inspect', 'b' * 64], ['run', '--privileged', ci.IMAGE]]:
            with self.assertRaises(ci.Refused):
                self.h.allow_argv(argv)
        with self.assertRaises(ci.Refused):
            self.h.created(b'unknown-cid', 'unit-ci-asset', 'asset', 2)
        self.assertTrue(self.h.unknown)

    def test_bad_resources_do_not_reach_subject(self):
        for sample in [{'at': self.now - 4, 'mem': 16 * ci.GIB, 'free': 64 * ci.GIB},
                       {'at': self.now, 'mem': True, 'free': 64 * ci.GIB},
                       {'at': self.now, 'mem': 3 * ci.GIB, 'free': 64 * ci.GIB}]:
            with patch.object(self.h, 'probe', return_value=sample), patch.object(ci.lower, '_run') as subject:
                with self.assertRaises(ci.Refused):
                    self.h.invoke(['version', '--format', '{{.Client.Version}}'])
                subject.assert_not_called()
            self.h.held = False  # Separate artificial guard cases, not a live epoch resume.


if __name__ == '__main__':
    unittest.main(verbosity=2)
