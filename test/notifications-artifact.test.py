"""Notifications content and verifier wiring, not real cryptographic proof."""
import importlib.util
import json
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from web_gateway_artifact import check_archive, contract, sha256, validate_manifest, write_archive
from module_artifact_verifier import authenticate
ARCH = {'x86_64': 'amd64', 'aarch64': 'arm64'}[platform.machine()]
SOURCE = 'a' * 40


class NotificationsArtifactTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.payload = self.root / 'payload'
        for name in ['src/notifications-entry.mjs', 'package.json', 'package-lock.json', 'node_modules/jose/package.json']:
            path = self.payload / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(name + '\n')
        self.archive = self.root / 'notifications.tar.gz'
        self.manifest = write_archive(self.payload, self.archive, SOURCE, ARCH, component='notifications')

    def test_minimal_self_contained_notifications_without_web_is_deterministic(self):
        again = self.root / 'again.tar.gz'
        write_archive(self.payload, again, SOURCE, ARCH, component='notifications')
        self.assertEqual(self.archive.read_bytes(), again.read_bytes())
        with self.archive.open('rb') as stream:
            manifest, digest = check_archive(stream, SOURCE, ARCH, component='notifications')
        self.assertEqual(manifest, self.manifest)
        self.assertEqual(manifest['schema'], 'bellteam.notifications.artifact.v1')
        self.assertEqual(manifest['runtime']['stateSchema'], 1)
        self.assertEqual(len(digest), 64)
        self.assertEqual(len(manifest['files']), 4)
        self.assertIn('payload/node_modules/jose/package.json', [f['path'] for f in manifest['files']])

    def test_web_component_and_nonexact_state_contracts_are_rejected(self):
        for change in [lambda m: m.update(component='web-gateway'),
                       lambda m: m.update(schema='bellteam.web-gateway.artifact.v1'),
                       lambda m: m.update(entry='payload/src/http-gateway-entry.mjs'),
                       lambda m: m['runtime'].pop('stateSchema'),
                       lambda m: m['runtime'].update(stateSchema=2),
                       lambda m: m['runtime'].update(stateSchema=True),
                       lambda m: m['runtime'].update(parentProtocol=2),
                       lambda m: m['runtime'].update(nodeMajor=27),
                       lambda m: m.update(policy={'allowUnsigned': True}),
                       lambda m: m.update(files=m['files'][:-1])]:
            value = json.loads(json.dumps(self.manifest)); change(value)
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_manifest(value, SOURCE, ARCH, component='notifications')
        with self.archive.open('rb') as stream, self.assertRaises(ValueError):
            check_archive(stream, SOURCE, ARCH)
        for component in ['unknown', '../notifications', 'web-gateway/notifications']:
            with self.assertRaisesRegex(ValueError, 'MODULE_COMPONENT_INVALID'):
                contract(component)

    def test_notifications_policy_pins_workflow_and_fd_snapshot(self):
        policy = json.loads((ROOT / 'config/notifications-verification.json').read_text())
        web_policy = json.loads((ROOT / 'config/web-gateway-verification.json').read_text())
        expectation = dict(archiveSha256=sha256(self.archive.read_bytes()), sourceCommit=SOURCE, signerCommit='b' * 40)
        bundle = self.root / 'bundle.json'; bundle.write_text('{}')
        trusted = self.root / 'trusted'; trusted.write_text('{}')
        proof = [{'verificationResult': {'signature': {'certificate': {'sourceRepositoryIdentifier': '1404510084'}}}}]
        with self.archive.open('rb') as a, bundle.open('rb') as b, trusted.open('rb') as t:
            aliases = []
            def official(command, **options):
                for flag, value in [('--signer-workflow', 'kitepon/BellTeam/.github/workflows/publish-notifications.yml'),
                                    ('--source-digest', SOURCE), ('--signer-digest', 'b' * 40)]:
                    self.assertEqual(command[command.index(flag) + 1], value)
                self.assertEqual(options['pass_fds'], (a.fileno(), b.fileno(), t.fileno()))
                self.assertNotIn('GH_TOKEN', options['env'])
                alias = Path(command[command.index('--bundle') + 1]); aliases.append(alias)
                self.assertEqual(alias.stat().st_ino, bundle.stat().st_ino)
                return subprocess.CompletedProcess(command, 0, json.dumps(proof).encode(), b'')
            with patch('subprocess.check_output', return_value='26\n'), patch('subprocess.run', side_effect=official):
                result = authenticate(a, b, t, policy, expectation, component='notifications')
                self.assertEqual(result['schema'], 'bellteam.notifications.verification.v1')
                self.assertEqual(result['manifest'], self.manifest)
            self.assertTrue(aliases and all(not alias.parent.exists() for alias in aliases))
            with patch('subprocess.check_output', return_value='26\n'), patch('subprocess.run') as run:
                for bad_policy in [web_policy, {**policy, 'signerWorkflow': web_policy['signerWorkflow']}]:
                    with self.assertRaises(ValueError):
                        authenticate(a, b, t, bad_policy, expectation, component='notifications')
                run.assert_not_called()

    def test_root_probe_refuses_shared_existing_paths_before_mutation(self):
        spec = importlib.util.spec_from_file_location('notifications_probe', ROOT / 'test/helpers/notifications-artifact-probe.py')
        probe = importlib.util.module_from_spec(spec); spec.loader.exec_module(probe)
        with patch('os.readlink', return_value='mnt:[same]'), self.assertRaisesRegex(ValueError, 'NOTIFICATIONS_PROBE_PRIVATE_MOUNT_NAMESPACE_REQUIRED'):
            probe.private_mount_namespace()
        with patch('os.geteuid', return_value=1000), self.assertRaisesRegex(ValueError, 'NOTIFICATIONS_PROBE_ROOT_REQUIRED'):
            probe.clean_runner()
        with patch('os.geteuid', return_value=0), patch.object(probe, 'APP', self.root), \
             self.assertRaisesRegex(ValueError, 'NOTIFICATIONS_PROBE_REQUIRES_CLEAN_RUNNER'):
            probe.clean_runner()

    def test_unsigned_fixed_cli_does_not_claim_authentication(self):
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/verify-notifications.py'),
                                 str(self.archive), str(self.archive), str(self.archive)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b'')
        self.assertIn(b'NOTIFICATIONS_VERIFICATION_FAILED', result.stderr)


if __name__ == '__main__':
    unittest.main()
