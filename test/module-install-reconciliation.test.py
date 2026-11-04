import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('reconciliation_service', ROOT / 'scripts/module-update-service.py')
service = importlib.util.module_from_spec(spec); spec.loader.exec_module(service)
host = service.host


class ReconciliationInspection(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.private = self.root / 'private'; self.private.mkdir(mode=0o750)
        self.prefix = self.root / 'updater'; self.prefix.mkdir(mode=0o700); (self.prefix / 'state').mkdir(mode=0o700)
        self.updater = service.ModuleUpdater(self.prefix, self.private,
            dict(release='a'*40, platform=dict(os='linux', arch='amd64')), uid=os.getuid())
        info = self.private.stat()
        self.volume = dict(device=str(info.st_dev), inode=str(info.st_ino))
        self.current = dict(sourceCommit='a'*40, platform=dict(os='linux', arch='amd64'), privateVolume=self.volume)
        self.updater.inspect_current = lambda: self.current
        self.updater.assert_model_binding = lambda value: self.assertEqual(value, self.current)
        self.updater.worker_alive = lambda _worker: False
        self.request = '53d582f5-2dc1-4e5d-810c-1f03ee06f7be'; self.plan_id = '5cd4bfd1-9baf-409c-aeb9-e1c0c4b49716'
        self.directory = self.updater.state / 'operations' / self.request; self.directory.mkdir(mode=0o700)
        self.target = dict(componentId='execution', versionId='b'*64, sourceCommit='c'*40,
            artifact=dict(archive=dict(sha256='b'*64), signerCommit='c'*40))
        self.operation = dict(requestId=self.request, planId=self.plan_id, target=self.target,
            admission='accepted', phase='unknown', execution='unknown', verification='unknown',
            error='HOST_UPDATE_WORKER_LOST', updatedAt='2026-11-04T11:38:00+00:00', worker={'fixture': True})
        host.atomic(self.directory / 'operation.json', self.operation)
        host.atomic(self.updater.state / 'plans' / (self.plan_id + '.json'),
            dict(planId=self.plan_id, target=self.target, expected=self.current, expiresAt='2000-01-01T00:00:00Z'))
        host.atomic(self.directory / 'module-volume.json', self.volume)
        self.original = (self.directory / 'operation.json').read_bytes()
        self.original_stat = (self.directory / 'operation.json').stat()
        self.params = dict(requestId=self.request, originalOperationSha256=hashlib.sha256(self.original).hexdigest())
        component = self.private / 'execution'; component.mkdir(mode=0o755); (component / 'releases').mkdir(mode=0o755)
        for path in [self.updater.state / 'worker.lock', self.updater.state / 'ledger.lock', component / '.install.lock']:
            path.touch(mode=0o600)
        self.installer = service.load_module('fixture_inspection_installer', 'install-web-gateway-release.py')
        self.installer.ROOT_UID = os.getuid()
        self.loader = patch.object(service, 'load_module', return_value=self.installer); self.loader.start(); self.addCleanup(self.loader.stop)

    def assert_original_untouched(self):
        path = self.directory / 'operation.json'
        self.assertEqual(path.read_bytes(), self.original)
        self.assertEqual(path.stat().st_mtime_ns, self.original_stat.st_mtime_ns)
        self.assertFalse((self.directory / 'claimed').exists())

    def test_absent_inspection_and_pure_read_preserve_original_unknown(self):
        result = self.updater.dispatch(dict(operation='inspectModuleInstall', params=self.params))
        self.assertEqual(result['receipt']['placement'], 'absent')
        self.assertEqual(result['receipt']['quiescence'], 'confirmed')
        self.assertEqual(result['receiptSha256'], service.reconciliation_hash(result['receipt']))
        with patch.object(self.updater, 'inspect_current', side_effect=AssertionError('read started inspection')):
            self.assertEqual(self.updater.dispatch(dict(operation='readInstallReconciliation', params=self.params)), result)
        self.assert_original_untouched()
        self.assertFalse((self.directory / 'recovery-claim.json').exists())
        with self.assertRaises(host.Failure):
            self.updater.inspect_module_install({**self.params, 'originalOperationSha256': '0'*64})
        with self.assertRaises(host.Failure):
            self.updater.inspect_module_install({**self.params, 'path': str(self.private)})

    def test_real_busy_and_unowned_stage_and_unknown_claim_block_evidence(self):
        with service.reconciliation_lock(self.updater.state / 'worker.lock', os.getuid()):
            result = self.updater.inspect_module_install(self.params)['receipt']
        self.assertEqual((result['placement'], result['quiescence']), ('unconfirmed', 'busy'))
        orphan = self.private / 'execution/.staging-unowned'; orphan.mkdir(mode=0o700)
        result = self.updater.inspect_module_install(self.params)['receipt']
        self.assertEqual(result['reason'], 'HOST_MODULE_UNOWNED_STAGE'); self.assertTrue(orphan.exists()); orphan.rmdir()
        host.atomic(self.directory / 'recovery-claim.json', dict(status='claimed'))
        result = self.updater.inspect_module_install(self.params)['receipt']
        self.assertEqual((result['recoveryState'], result['quiescence']), ('unknown', 'unconfirmed'))
        self.assert_original_untouched()

    def test_fixed_readonly_release_checks_full_inventory_without_import(self):
        artifact_spec = importlib.util.spec_from_file_location('fixture_artifact', ROOT / 'scripts/web_gateway_artifact.py')
        artifact = importlib.util.module_from_spec(artifact_spec); artifact_spec.loader.exec_module(artifact)
        payload = self.root / 'payload'
        for name in artifact.EXECUTION_FILES:
            path = self.root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('not executable: ' + name)
        archive = self.root / 'fixture.tar.gz'
        manifest = artifact.write_archive(payload, archive, 'c'*40, 'amd64', component='execution')
        with archive.open('rb') as stream: _, manifest_sha = artifact.check_archive(stream, component='execution')
        expected = self.installer.expectation('b'*64, 'c'*40, 'c'*40)
        receipt = dict(schema='bellteam.execution.verification.v1', archiveSha256='b'*64, manifestSha256=manifest_sha,
            manifest=manifest, verification=dict(method='github-oidc-attestation', repositoryId='1404510084'))
        target = self.private / 'execution/releases' / ('b'*64); target.mkdir(mode=0o700)
        self.installer.extract(archive, receipt, expected, target, 'execution')
        def cleanup():
            for path in [target, *target.rglob('*')]:
                if path.is_dir(): path.chmod(0o700)
        self.addCleanup(cleanup)
        result = self.updater.inspect_module_install(self.params)['receipt']
        self.assertEqual((result['placement'], result['manifestSha256']), ('verified_present', manifest_sha))
        altered = target / manifest['files'][0]['path']; altered.chmod(0o600); altered.write_bytes(b'bad'); altered.chmod(0o444)
        result = self.updater.inspect_module_install(self.params)['receipt']
        self.assertEqual(result['placement'], 'unconfirmed')
        self.assertEqual(result['reason'], 'HOST_MODULE_INSPECTION_UNCONFIRMED')
        self.assert_original_untouched()

    def test_private_client_validates_actual_receipt_and_closed_boundaries(self):
        result = self.updater.inspect_module_install(self.params)
        script = '''
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateInstallReconciliation as valid, installReconciliationHash as hash } from './src/container-update-client.mjs';
const result = JSON.parse(readFileSync(0, 'utf8'));
assert.equal(valid(result), true);
for (const mutate of [r => r.receipt.path = '/untrusted', r => r.receipt.requestId = 'wrong',
  r => r.receipt.quiescence = 'forced', r => r.receipt.manifestSha256 = 'a'.repeat(64),
  r => r.receipt.recoveryState = 'unknown']) {
  const invalid = structuredClone(result); mutate(invalid);
  invalid.receiptSha256 = hash(invalid.receipt);
  assert.equal(valid(invalid), false);
}
result.receiptSha256 = '0'.repeat(64); assert.equal(valid(result), false);
'''
        subprocess.run(['node', '--input-type=module', '-e', script], input=json.dumps(result),
            cwd=ROOT, text=True, check=True, capture_output=True)


if __name__ == '__main__': unittest.main()
