"""Notifications content and verifier wiring, not real cryptographic proof."""
import importlib.util
import json
import os
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
        self.assertEqual(manifest['runtime']['stateSchema'], 2)
        self.assertEqual(len(digest), 64)
        self.assertEqual(len(manifest['files']), 4)
        self.assertIn('payload/node_modules/jose/package.json', [f['path'] for f in manifest['files']])

    def test_web_component_and_nonexact_state_contracts_are_rejected(self):
        for change in [lambda m: m.update(component='web-gateway'),
                       lambda m: m.update(schema='bellteam.web-gateway.artifact.v1'),
                       lambda m: m.update(entry='payload/src/http-gateway-entry.mjs'),
                       lambda m: m['runtime'].pop('stateSchema'),
                       lambda m: m['runtime'].update(stateSchema=1),
                       lambda m: m['runtime'].update(stateSchema=True),
                       lambda m: m['runtime'].update(parentProtocol=1),
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

    def test_catalog_requires_exact_abi2_and_matching_archive_identity(self):
        from update_catalog import validate_notifications_archive, validate_notifications_compatibility
        compatibility = dict(nodeMajor=26, parentProtocol=2, stateSchema=2, containerUpdate=None)
        release = dict(componentId='notifications', sourceCommit=SOURCE,
                       platform=dict(os='linux', arch=ARCH), compatibility=compatibility)
        self.assertIs(validate_notifications_archive(release, self.manifest), self.manifest)
        for key, value in [('nodeMajor', None), ('parentProtocol', 1), ('stateSchema', 1),
                           ('parentProtocol', True), ('stateSchema', '2'), ('containerUpdate', 1)]:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                validate_notifications_compatibility({**compatibility, key: value})
        for value in [{k: v for k, v in compatibility.items() if k != 'stateSchema'},
                      {**compatibility, 'origin': 'https://fixture.example'}]:
            with self.assertRaises(ValueError): validate_notifications_compatibility(value)
        for mutate in [lambda m: m.update(sourceCommit='b' * 40),
                       lambda m: m['runtime'].update(arch='arm64' if ARCH == 'amd64' else 'amd64'),
                       lambda m: m['runtime'].update(parentProtocol=1, stateSchema=1)]:
            manifest = json.loads(json.dumps(self.manifest)); mutate(manifest)
            with self.assertRaises(ValueError): validate_notifications_archive(release, manifest)

    def test_parent_probe_resolves_only_staged_payload_dependencies(self):
        spec = importlib.util.spec_from_file_location('notifications_probe', ROOT / 'test/helpers/notifications-artifact-probe.py')
        probe = importlib.util.module_from_spec(spec); spec.loader.exec_module(probe)
        checkout = self.root / 'checkout'; (checkout / 'scripts').mkdir(parents=True)
        parent = checkout / 'scripts/probe-notifications-runtime.mjs'
        parent.write_text("import { value } from '../src/entry.mjs'; console.log(value)\n")
        app = self.root / 'app'; (app / 'src').mkdir(parents=True)
        (app / 'src/entry.mjs').write_text("import value from 'probe-dependency'; export { value }\n")
        dependency = app / 'node_modules/probe-dependency'; dependency.mkdir(parents=True)
        (dependency / 'package.json').write_text('{"type":"module","exports":"./index.mjs"}')
        (dependency / 'index.mjs').write_text("export default 'payload-dependency'\n")
        with patch.object(probe, 'APP', app), patch.object(probe, 'ROOT', checkout): staged = probe.stage_parent_probe()
        self.assertEqual(staged.read_bytes(), parent.read_bytes())
        for path in app.rglob('*'): path.chmod(0o555 if path.is_dir() else 0o444)
        result = subprocess.run(['node', str(staged)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'payload-dependency\n')
        for path in app.rglob('*'):
            if path.is_dir(): path.chmod(0o755)

    def test_publication_checks_official_notifications_policy_then_archive(self):
        spec = importlib.util.spec_from_file_location('publication', ROOT / 'scripts/check-update-catalog-publication.py')
        publication = importlib.util.module_from_spec(spec); spec.loader.exec_module(publication)
        release = dict(componentId='notifications', sourceCommit=SOURCE, platform=dict(os='linux', arch=ARCH),
            compatibility=dict(nodeMajor=26, parentProtocol=2, stateSchema=2, containerUpdate=None),
            artifact=dict(archive={}, bundle={}, signerCommit='b' * 40))
        with patch.object(publication, 'download_asset', side_effect=[self.archive.read_bytes(), b'{}']), \
             patch('module_artifact_verifier.verify_signature') as official:
            publication.verify_notifications_release(release)
            self.assertEqual(official.call_args.args[3]['signerWorkflow'],
                             'kitepon/BellTeam/.github/workflows/publish-notifications.yml')
            self.assertEqual(official.call_args.kwargs, dict(source=SOURCE, signer='b' * 40))

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

    def test_root_probe_directory_creation_sets_actual_owner_group_and_mode(self):
        spec = importlib.util.spec_from_file_location('notifications_probe', ROOT / 'test/helpers/notifications-artifact-probe.py')
        probe = importlib.util.module_from_spec(spec); spec.loader.exec_module(probe)
        path = self.root / 'probe-private'; created = []
        probe.create_directory(path, os.getuid(), os.getgid(), 0o750, created)
        info = path.stat()
        self.assertEqual((info.st_uid, info.st_gid, info.st_mode & 0o7777), (os.getuid(), os.getgid(), 0o750))
        self.assertEqual(created, [path])

    def test_unsigned_fixed_cli_does_not_claim_authentication(self):
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/verify-notifications.py'),
                                 str(self.archive), str(self.archive), str(self.archive)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b'')
        self.assertIn(b'NOTIFICATIONS_VERIFICATION_FAILED', result.stderr)


if __name__ == '__main__':
    unittest.main()
