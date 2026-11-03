import copy
import hashlib
import importlib.util
import json
import platform
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from web_gateway_artifact import BUSINESS_FILES, BUSINESS_STATE, check_archive, validate_manifest, write_archive
from update_catalog import validate_business_archive
import module_artifact_verifier as verifier


class BusinessArtifacts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}[platform.machine()]

    def artifact(self, component):
        root = self.root / component; root.mkdir()
        for name in BUSINESS_FILES[component]:
            path = root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(name)
        archive = root / 'archive.tar.gz'
        write_archive(root / 'payload', archive, 'a' * 40, self.arch, component=component)
        with archive.open('rb') as stream: manifest, digest = check_archive(stream, component=component)
        return archive, manifest, digest

    def test_manifest_rejects_missing_extra_replaced_source_and_state(self):
        for component in BUSINESS_FILES:
            _, manifest, _ = self.artifact(component)
            for change in [lambda m: m['files'].pop(),
                           lambda m: m['files'].append(dict(path='payload/src/other-engine.mjs', bytes=0, sha256='b' * 64)),
                           lambda m: m['files'][0].update(path='payload/src/replaced.mjs'),
                           lambda m: m['runtime']['stateCompatibility'].update(unknown='new'),
                           lambda m: m['runtime'].update(parentProtocol=2)]:
                value = copy.deepcopy(manifest); change(value)
                with self.subTest(component=component), self.assertRaises(ValueError):
                    validate_manifest(value, component=component)

    def test_catalog_manifest_consumer_are_bound_to_same_source_and_state(self):
        for component in BUSINESS_FILES:
            _, manifest, _ = self.artifact(component)
            state = BUSINESS_STATE[component]
            release = dict(componentId=component, sourceCommit='a' * 40, platform=dict(os='linux', arch=self.arch),
                compatibility=dict(nodeMajor=26, parentProtocol=1, stateSchema=None, containerUpdate=None, stateCompatibility=state))
            validate_business_archive(release, manifest, state)
            for changed in [{**state, 'unknown': True}, {}]:
                with self.assertRaises(ValueError): validate_business_archive(release, manifest, changed)
            with self.assertRaises(ValueError): validate_business_archive({**release, 'sourceCommit': 'b' * 40}, manifest, state)

    def test_trusted_image_state_must_match_after_official_signature(self):
        for component in BUSINESS_FILES:
            archive, manifest, _ = self.artifact(component)
            expected = dict(archiveSha256=hashlib.sha256(archive.read_bytes()).hexdigest(), sourceCommit='a' * 40, signerCommit='a' * 40)
            def output(command, **options):
                return '26\n' if '-p' in command else json.dumps(BUSINESS_STATE[component])
            with archive.open('rb') as a, archive.open('rb') as b, archive.open('rb') as t, patch.object(verifier, 'verify_signature') as signature, patch.object(verifier.subprocess, 'check_output', side_effect=output):
                self.assertEqual(verifier.authenticate(a, b, t, verifier.policy_for(component), expected, component=component)['manifest'], manifest)
                signature.assert_called_once()
            with archive.open('rb') as a, archive.open('rb') as b, archive.open('rb') as t, patch.object(verifier, 'verify_signature'), patch.object(verifier.subprocess, 'check_output', side_effect=['26\n', '{}']):
                with self.assertRaisesRegex(ValueError, 'IMAGE_STATE_INCOMPATIBLE'):
                    verifier.authenticate(a, b, t, verifier.policy_for(component), expected, component=component)

    def test_unknown_component_cannot_select_signer(self):
        with self.assertRaises(ValueError): verifier.policy_for('arbitrary')
        self.assertNotEqual(verifier.policy_for('usage'), verifier.policy_for('diagnostics'))

    def test_installer_rejects_cross_component_receipt_before_publication(self):
        spec = importlib.util.spec_from_file_location('installer', ROOT / 'scripts/install-web-gateway-release.py')
        installer = importlib.util.module_from_spec(spec); spec.loader.exec_module(installer)
        for component in BUSINESS_FILES:
            archive, manifest, manifest_sha = self.artifact(component)
            expected = dict(archiveSha256=hashlib.sha256(archive.read_bytes()).hexdigest(), sourceCommit='a' * 40, signerCommit='a' * 40)
            receipt = dict(schema=f'bellteam.{component}.verification.v1', archiveSha256=expected['archiveSha256'], manifestSha256=manifest_sha,
                manifest=manifest, verification=dict(method='github-oidc-attestation', repositoryId='1404510084'))
            target = self.root / (component + '-installed'); target.mkdir()
            wrong = copy.deepcopy(receipt); wrong['manifest']['component'] = 'members'
            with self.assertRaises(ValueError): installer.extract(archive, wrong, expected, target, component)
            self.assertEqual(list(target.iterdir()), [])
            try:
                installer.extract(archive, receipt, expected, target, component)
                installed = json.loads((target / 'installation.json').read_text())
                self.assertEqual(installed['component'], component)
                self.assertEqual((target.stat().st_mode & 4095), 0o555)
                for row in manifest['files']:
                    self.assertEqual(hashlib.sha256((target / row['path']).read_bytes()).hexdigest(), row['sha256'])
                    self.assertEqual((target / row['path']).stat().st_mode & 4095, 0o444)
            finally:
                for path in [target, *target.rglob('*')]:
                    if path.is_dir(): path.chmod(0o700)

    def test_probe_parent_dependencies_are_outside_child_payload(self):
        spec = importlib.util.spec_from_file_location('probe', ROOT / 'test/helpers/members-artifact-probe.py')
        probe = importlib.util.module_from_spec(spec); spec.loader.exec_module(probe)
        app = self.root / 'app'; app.mkdir(); (app / 'child-only').write_text('fixed')
        created = []
        with patch.object(probe, 'APP', app):
            parent = probe.stage_parent_probe('usage', created)
        self.assertFalse(parent.is_relative_to(app))
        self.assertEqual(sorted(p.name for p in app.iterdir()), ['child-only'])
        self.assertTrue((parent.parent.parent / 'src/members-admission.mjs').is_file())
        import shutil
        for path in created: shutil.rmtree(path)


if __name__ == '__main__': unittest.main()
