"""Content and mocked-verifier boundaries; these tests supply no real signing proof."""
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import platform
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from web_gateway_artifact import check_archive, sha256, validate_manifest, write_archive
spec = importlib.util.spec_from_file_location('gateway_verify', ROOT / 'scripts/verify-web-gateway.py')
verify = importlib.util.module_from_spec(spec); spec.loader.exec_module(verify)
ARCH = {'x86_64': 'amd64', 'aarch64': 'arm64'}[platform.machine()]
SOURCE = 'a' * 40


class GatewayArtifactTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.payload = self.root / 'payload'; self.payload.mkdir()
        for name in ['package.json', 'package-lock.json', 'src/http-gateway-entry.mjs',
                     'web/assets.mjs', 'node_modules/@modelcontextprotocol/sdk/package.json',
                     'services/subscriptions/product.json', 'services/subscriptions/endpoints.json']:
            f = self.payload / name; f.parent.mkdir(parents=True, exist_ok=True); f.write_text(name + '\n')
        self.archive = self.root / 'archive.tar.gz'
        self.manifest = write_archive(self.payload, self.archive, SOURCE, ARCH)

    def rewrite(self, change):
        out = io.BytesIO()
        with tarfile.open(fileobj=out, mode='w', format=tarfile.USTAR_FORMAT) as destination:
            with tarfile.open(self.archive, 'r:gz') as source:
                for member in source:
                    raw = source.extractfile(member).read()
                    replacement = change(member, raw)
                    if replacement is None: continue
                    member, raw = replacement
                    member.size = len(raw)
                    destination.addfile(member, io.BytesIO(raw))
        return io.BytesIO(gzip.compress(out.getvalue(), mtime=0))

    def test_deterministic_complete_archive(self):
        again = self.root / 'again.tar.gz'
        write_archive(self.payload, again, SOURCE, ARCH)
        self.assertEqual(again.read_bytes(), self.archive.read_bytes())
        with self.archive.open('rb') as file:
            manifest, digest = check_archive(file, SOURCE, ARCH)
        self.assertEqual(manifest, self.manifest)
        self.assertEqual(len(digest), 64)
        self.assertIn('payload/node_modules/@modelcontextprotocol/sdk/package.json', [f['path'] for f in manifest['files']])

    def test_tampering_missing_dependency_and_duplicate_or_escape_are_rejected(self):
        mutations = [
            lambda m, b: (m, b'changed') if m.name.endswith('entry.mjs') else (m, b),
            lambda m, b: None if m.name.startswith('payload/node_modules/') else (m, b),
            lambda m, b: (tarfile.TarInfo('payload/../outside'), b) if m.name.endswith('entry.mjs') else (m, b),
            lambda m, b: (tarfile.TarInfo('manifest.json'), b) if m.name.endswith('entry.mjs') else (m, b),
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutations.index(mutation)), self.assertRaises(ValueError):
                check_archive(self.rewrite(mutation), SOURCE, ARCH)

    def test_internal_npm_file_link_is_flattened_but_external_link_is_rejected(self):
        link = self.payload / 'node_modules/link.js'
        link.symlink_to('../web/assets.mjs')
        output = self.root / 'linked.tar.gz'
        write_archive(self.payload, output, SOURCE, ARCH)
        with tarfile.open(output, 'r:gz') as tar:
            self.assertTrue(tar.getmember('payload/node_modules/link.js').isfile())
        link.unlink(); link.symlink_to(self.root / 'outside')
        (self.root / 'outside').write_text('private')
        with self.assertRaisesRegex(ValueError, 'GATEWAY_LINK_INVALID'):
            write_archive(self.payload, self.root / 'escaped.tar.gz', SOURCE, ARCH)

    def test_foreign_source_arch_and_claimed_authentication_are_rejected(self):
        for change in [lambda m: m.update(sourceCommit='b' * 40),
                       lambda m: m['runtime'].update(arch='unknown'),
                       lambda m: m.update(authenticationSucceeded=True)]:
            value = json.loads(json.dumps(self.manifest)); change(value)
            with self.assertRaises(ValueError): validate_manifest(value, SOURCE, ARCH)
        # Non-entry files are the module's own signed decision; the entry stays required.
        value = json.loads(json.dumps(self.manifest))
        value['files'] = [f for f in value['files'] if not f['path'].startswith('payload/services/')]
        self.assertIs(validate_manifest(value, SOURCE, ARCH), value)
        value['files'] = [f for f in value['files'] if f['path'] != value['entry']]
        with self.assertRaises(ValueError): validate_manifest(value, SOURCE, ARCH)

    def test_mocked_official_result_is_bound_to_fds_expected_sha_and_repository(self):
        # The positive mock exercises policy wiring, never cryptographic success or installation.
        bundle = self.root / 'bundle'; bundle.write_text('{}')
        trusted = self.root / 'trusted'; trusted.write_text('{}')
        policy = json.loads((ROOT / 'config/web-gateway-verification.json').read_text())
        expected = dict(archiveSha256=sha256(self.archive.read_bytes()), sourceCommit=SOURCE, signerCommit=SOURCE)
        proof = [{'verificationResult': {'signature': {'certificate': {'sourceRepositoryIdentifier': '1404510084'}}}}]
        with self.archive.open('rb') as a, bundle.open('rb') as b, trusted.open('rb') as t:
            aliases = []
            def official_shape(command, **options):
                alias = Path(command[command.index('--bundle') + 1]); aliases.append(alias)
                self.assertEqual(alias.suffix, '.json')
                self.assertTrue(alias.is_symlink())
                self.assertEqual(alias.parent.stat().st_mode & 0o777, 0o700)
                self.assertEqual(alias.stat().st_ino, bundle.stat().st_ino)
                self.assertEqual(alias.read_bytes(), bundle.read_bytes())
                return subprocess.CompletedProcess([], 0, json.dumps(proof).encode(), b'')
            with patch('subprocess.check_output', return_value='26\n'), patch('subprocess.run', side_effect=official_shape) as run:
                result = verify.authenticate(a, b, t, policy, expected)
                self.assertEqual(result['manifest'], self.manifest)
                self.assertEqual(run.call_args.kwargs['pass_fds'], (a.fileno(), b.fileno(), t.fileno()))
                self.assertNotIn('GH_TOKEN', run.call_args.kwargs['env'])
                self.assertIn('--signer-digest', run.call_args.args[0])
            self.assertTrue(aliases and all(not alias.parent.exists() for alias in aliases))
            with patch('subprocess.check_output', return_value='26\n'), patch('subprocess.run') as run:
                with self.assertRaisesRegex(ValueError, 'GATEWAY_ARCHIVE_DIGEST_MISMATCH'):
                    verify.authenticate(a, b, t, policy, {**expected, 'archiveSha256': '0' * 64})
                run.assert_not_called()
            proof[0]['verificationResult']['signature']['certificate']['sourceRepositoryIdentifier'] = 'foreign'
            with patch('subprocess.check_output', return_value='26\n'), patch('subprocess.run', return_value=subprocess.CompletedProcess([], 0, json.dumps(proof).encode(), b'')):
                with self.assertRaisesRegex(ValueError, 'GATEWAY_REPOSITORY_ID_MISMATCH'):
                    verify.authenticate(a, b, t, policy, expected)
            def rejected_official(command, **options):
                official_shape(command, **options)
                raise subprocess.CalledProcessError(1, 'gh')
            with patch('subprocess.check_output', return_value='26\n'), patch('subprocess.run', side_effect=rejected_official):
                with self.assertRaises(subprocess.CalledProcessError): verify.authenticate(a, b, t, policy, expected)
            self.assertTrue(all(not alias.parent.exists() for alias in aliases))

    def test_existing_output_and_unsigned_cli_never_claim_success(self):
        with self.assertRaises(FileExistsError): write_archive(self.payload, self.archive, SOURCE, ARCH)
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/verify-web-gateway.py'),
            str(self.archive), str(self.archive), str(self.archive)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b'')


if __name__ == '__main__':
    unittest.main()
