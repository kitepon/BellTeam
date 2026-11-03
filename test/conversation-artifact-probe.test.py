"""Finite fixture placement and workflow wiring; no root/native/signing execution."""
import importlib.util
from contextlib import ExitStack
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('conversation_probe', ROOT / 'test/helpers/conversation-artifact-probe.py')
probe = importlib.util.module_from_spec(spec); spec.loader.exec_module(probe)
FIXTURE = Path('src/conversation/probe-fixture.json')


class ConversationProbe(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name); self.checkout = self.root / 'checkout'; self.app = self.root / 'app'
        self.state = self.root / 'state'; self.state.mkdir()
        self.raw = (ROOT / FIXTURE).read_bytes()
        for root in [self.checkout, self.app]:
            (root / FIXTURE).parent.mkdir(parents=True)
            (root / FIXTURE).write_bytes(self.raw)
        self.stack = ExitStack(); self.addCleanup(self.stack.close)
        for name, value in [('ROOT', self.checkout), ('APP', self.app), ('STATE', self.state)]:
            self.stack.enter_context(patch.object(probe, name, value))

    def test_shared_runner_or_mount_namespace_refused_before_writes(self):
        with patch('os.geteuid', return_value=1000), self.assertRaisesRegex(ValueError, 'ROOT_REQUIRED'):
            probe.clean_runner()
        with patch('os.geteuid', return_value=0), self.assertRaisesRegex(ValueError, 'REQUIRES_CLEAN_RUNNER'):
            probe.clean_runner()
        with patch('os.readlink', return_value='mnt:[same]'), self.assertRaisesRegex(ValueError, 'PRIVATE_MOUNT_NAMESPACE_REQUIRED'):
            probe.private_mount_namespace()

    def test_author_fixture_serialization_modes_and_snapshot_detect_changes(self):
        created = []
        with patch('os.chown') as owner: probe.seed_conversation_state(created)
        for call in owner.call_args_list: self.assertEqual(call.args[1:], (1001, 1001))
        fixture = json.loads(self.raw)
        for name, value in fixture['files'].items():
            path = self.state / name
            self.assertEqual(path.read_text(), json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.state / 'rooms').stat().st_mode & 0o777, 0o700)
        before = probe.snapshot_state()
        self.assertEqual(before, probe.snapshot_state())
        path = self.state / 'logs/self-turns.json'; path.write_text('{}\n')
        self.assertNotEqual(before, probe.snapshot_state())
        (self.state / 'logs/unexpected').write_text('')
        self.assertIn('logs/unexpected', probe.snapshot_state())
        (self.state / 'logs/link').symlink_to(path)
        with self.assertRaisesRegex(ValueError, 'STATE_INVALID'): probe.snapshot_state()

    def test_foreign_fixture_or_extra_paths_reject_before_state_mutation(self):
        (self.app / FIXTURE).write_text('{}')
        with self.assertRaisesRegex(ValueError, 'FIXTURE_SOURCE_MISMATCH'): probe.seed_conversation_state([])
        value = json.loads(self.raw); value['files']['../outside.json'] = {}
        raw = json.dumps(value)
        for root in [self.app, self.checkout]: (root / FIXTURE).write_text(raw)
        with self.assertRaisesRegex(ValueError, 'FIXTURE_INVALID'): probe.seed_conversation_state([])
        self.assertEqual(list(self.state.iterdir()), [])
        self.assertFalse((self.root / 'outside.json').exists())

    def test_staged_parent_uses_payload_dependencies_and_same_probe_bytes(self):
        (self.checkout / 'scripts').mkdir()
        parent = self.checkout / 'scripts/probe-conversation-runtime.mjs'
        parent.write_text("import value from 'probe-dependency'; console.log(value)\n")
        dependency = self.app / 'node_modules/probe-dependency'; dependency.mkdir(parents=True)
        (dependency / 'package.json').write_text('{"type":"module","exports":"./index.mjs"}')
        (dependency / 'index.mjs').write_text("export default 'payload-only'\n")
        staged = probe.stage_parent_probe()
        self.assertEqual(staged.read_bytes(), parent.read_bytes())
        result = subprocess.run(['node', str(staged)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'payload-only\n')
        self.assertFalse((self.checkout / 'node_modules').exists())

    def test_dedicated_main_native_probe_precedes_official_attestation(self):
        workflow = json.loads((ROOT / '.github/workflows/publish-conversation.yml').read_text())
        job = workflow['jobs']['package']; steps = job['steps']
        self.assertIn("github.ref == 'refs/heads/main'", job['if'])
        self.assertEqual({row['arch'] for row in job['strategy']['matrix']['include']}, {'amd64', 'arm64'})
        probe_index = next(i for i, step in enumerate(steps) if 'unshare --mount' in step.get('run', ''))
        sign_index = next(i for i, step in enumerate(steps) if step.get('id') == 'attest')
        self.assertLess(probe_index, sign_index)
        self.assertIn('test/helpers/conversation-artifact-probe.py', steps[probe_index]['run'])
        verify = next(step['run'] for step in steps if 'gh attestation verify' in step.get('run', ''))
        self.assertIn('--signer-workflow kitepon/BellTeam/.github/workflows/publish-conversation.yml', verify)
        self.assertIn('--source-digest "$SOURCE" --signer-digest "$SOURCE"', verify)
        self.assertTrue(any(step.get('if') == 'failure()' for step in steps))


class ConversationProbeReceipt(unittest.TestCase):
    def test_fixed_author_receipt_and_effect_boundaries(self):
        state = {'readerContract': 'fixture-only'}
        value = dict(schema='bellteam.conversation.runtime-probe.v1', ok=True,
                     uid=1001, protocolVersion=1, stateCompatibility=state, childClosed=True,
                     nativeAuth=False, externalEffects=0)
        probe.validate_probe_receipt(value, state)
        cases = [{k: v for k, v in value.items() if k != 'nativeAuth'},
                 {**value, 'nativeAuth': True}, {**value, 'nativeAuth': 0},
                 {**value, 'externalEffects': 1}, {**value, 'externalEffects': False},
                 {**value, 'externalEffects': 0.0}, {**value, 'extra': None},
                 {**value, 'childClosed': False}, {**value, 'stateCompatibility': {}},
                 {**value, 'ok': 1}, {**value, 'protocolVersion': True}, {**value, 'uid': 1001.0}]
        for invalid in cases:
            with self.subTest(value=invalid), self.assertRaisesRegex(ValueError, 'RECEIPT_INVALID'):
                probe.validate_probe_receipt(invalid, state)


if __name__ == '__main__': unittest.main()
