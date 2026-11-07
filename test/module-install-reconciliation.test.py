import hashlib
import datetime as dt
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
        self.request = '53d582f5-2dc1-4e5d-810c-1f03ee06f7be'; self.plan_id = '5cd4bfd1-9baf-409c-aeb9-e1c0c4b49716'
        self.directory = self.updater.state / 'operations' / self.request; self.directory.mkdir(mode=0o700)
        self.target = dict(componentId='execution', versionId='b'*64, sourceCommit='c'*40,
            artifact=dict(archive=dict(sha256='b'*64), signerCommit='c'*40))
        self.operation = dict(requestId=self.request, planId=self.plan_id, target=self.target,
            admission='accepted', phase='unknown', execution='unknown', verification='unknown',
            error='HOST_UPDATE_WORKER_LOST', updatedAt='2026-11-04T11:38:00+00:00',
            cleanup='pending', rollback='not_needed', observed=None,
            worker=dict(pid=os.getpid(), birth='0', pidNamespace=str(os.stat('/proc/self/ns/pid').st_ino)))
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

    def decision(self, inspection=None):
        inspection = inspection or self.updater.inspect_module_install(self.params)
        now = dt.datetime.now(dt.timezone.utc); r = inspection['receipt']
        body = dict(schema='bellteam.module-install-decision.v1',
            publicRequestId='7d5fecd8-29cb-4a06-aed5-32b45b334717', publicPlanId='c20e6fb8-dc64-434c-8d7b-d782d37dd4e2',
            requestId=self.request, planId=self.plan_id, originalOperationSha256=self.params['originalOperationSha256'],
            publicOperationSha256='d'*64, inspectionSha256=inspection['receiptSha256'], targetSha256=r['targetSha256'],
            storageBindingSha256=r['storageBindingSha256'], runtimeCurrentSha256=r['runtimeCurrentSha256'],
            currentSha256='e'*64, catalogSha256='f'*64, action='close_without_activation', issuedAt=now.isoformat(),
            expiresAt=(now+dt.timedelta(minutes=10)).isoformat(), ownerGrantRef='9'*64)
        return dict(decisionSha256=service.reconciliation_hash(body), decision=body)

    def close_params(self, decision=None):
        decision = decision or self.decision(); d = decision['decision']; now = host.stamp()
        body = dict(schema='bellteam.module-install-common-proof.v1',
            **{key: d[key] for key in ['publicRequestId','publicPlanId','requestId','planId','originalOperationSha256',
                'publicOperationSha256','currentSha256','ownerGrantRef']},
            decisionSha256=decision['decisionSha256'], applyState='not_issued', applyClaimSha256=None,
            resultSha256=None, claimedAt=now, verifiedAt=now)
        return dict(**self.params, decision=decision, commonProof=dict(proofSha256=service.reconciliation_hash(body),proof=body))

    def assert_original_untouched(self):
        path = self.directory / 'operation.json'
        self.assertEqual(path.read_bytes(), self.original)
        self.assertEqual(path.stat().st_mtime_ns, self.original_stat.st_mtime_ns)
        self.assertFalse((self.directory / 'claimed').exists())

    def test_current_successor_preserves_predecessor_and_finalize_only_reads(self):
        self.loader.stop()
        bridge = service.load_module('successor_fixture_bridge', 'module-worker-termination.py')
        loader = patch.object(service, 'load_module', side_effect=lambda name, filename:
            bridge if filename == 'module-worker-termination.py' else self.installer)
        loader.start(); self.addCleanup(loader.stop)
        self.operation['worker']['pidNamespace'] = '111'
        host.atomic(self.directory / 'operation.json', self.operation)
        self.original = (self.directory / 'operation.json').read_bytes()
        self.original_stat = (self.directory / 'operation.json').stat()
        self.params['originalOperationSha256'] = hashlib.sha256(self.original).hexdigest()
        plan_path = self.updater.state / 'plans' / (self.plan_id + '.json')
        plan_sha = hashlib.sha256(plan_path.read_bytes()).hexdigest()
        prepare = dict(schema='bellteam.module-worker-prepare.v1', requestId=self.request, planId=self.plan_id,
            originalOperationSha256=self.params['originalOperationSha256'], planSha256=plan_sha,
            targetSha256=bridge.digest(self.target), storageBindingSha256=bridge.digest(self.volume),
            ledgerBinding=bridge.binding(self.prefix), worker=self.operation['worker'],
            oldService=dict(containerId='d'*64, imageId='sha256:'+'f'*64, sourceCommit='a'*40,
                startedAt='2026-11-04T10:00:00Z', pidNamespace='111', modelSha256='e'*64, project='fixture'),
            target=dict(sourceCommit='b'*40, imageId='sha256:'+'e'*64), preparedAt='2026-11-04T10:01:00Z')
        termination = dict(schema='bellteam.module-worker-termination.v1', requestId=self.request,
            originalOperationSha256=prepare['originalOperationSha256'], prepareSha256=bridge.digest(prepare),
            oldContainerId='d'*64, status='stopped', running=False, restarting=False, pid=0, exitCode=0,
            finishedAt='2026-11-04T10:02:00Z', stoppedAt='2026-11-04T10:03:00Z')
        record = dict(prepareSha256=bridge.digest(prepare), prepare=prepare,
            terminationSha256=bridge.digest(termination), termination=termination)
        prepare_path = self.directory / 'worker-termination-prepare.json'
        record_path = self.directory / 'worker-termination.json'
        host.atomic(prepare_path, prepare); host.atomic(record_path, record)
        originals = {path: path.read_bytes() for path in [plan_path, prepare_path, record_path]}
        self.updater.config['release'] = 'b'*40; self.current['sourceCommit'] = 'b'*40
        self.assertEqual(bridge.read_termination(self.updater, host, self.directory, self.operation,
            host.read_json(plan_path, os.getuid()), plan_sha), bridge.digest(record))
        self.updater.config['release'] = 'c'*40; self.current['sourceCommit'] = 'c'*40
        self.updater.catalog = lambda _: {}
        successor = self.directory / ('worker-termination-successor-' + 'c'*40 + '.json')
        pending = successor.with_suffix('.pending')
        with self.assertRaises(host.Failure):
            bridge.read_termination(self.updater, host, self.directory, self.operation,
                host.read_json(plan_path, os.getuid()), plan_sha)
        # A caller deadline after publication leaves a complete fact, never a second claim.
        with patch.object(bridge, 'sync_directory', side_effect=OSError('lost publication acknowledgement')):
            self.assertEqual(self.updater.inspect_module_install(self.params)['receipt']['quiescence'], 'unconfirmed')
        published = successor.read_bytes()
        self.assertFalse(pending.exists())
        inspected = self.updater.inspect_module_install(self.params)
        self.assertEqual((inspected['receipt']['quiescence'], inspected['receipt']['placement']), ('confirmed', 'absent'))
        self.assertEqual(len(inspected['receipt']), 20)
        envelope = host.read_json(successor, os.getuid())
        self.assertEqual(set(envelope), {'successorSha256', 'successor'})
        self.assertEqual(len(envelope['successor']), 15)
        self.assertEqual(envelope['successor']['predecessorSha256'], bridge.digest(record))
        self.assertEqual(envelope['successor']['predecessorSourceCommit'], 'b'*40)
        self.assertEqual(envelope['successor']['currentSourceCommit'], 'c'*40)
        self.assertEqual(envelope['successorSha256'], bridge.digest(envelope['successor']))
        commitment = bridge.digest(dict(predecessorSha256=bridge.digest(record), successorSha256=envelope['successorSha256']))
        expected_evidence = service.reconciliation_hash(dict(current=self.current, target=self.target, planSha256=plan_sha,
            placement='absent', manifestSha256=None, stageState='clear', recoveryState='not_issued', fence='open',
            workerTerminationSha256=commitment))
        self.assertEqual(inspected['receipt']['evidenceSha256'], expected_evidence)
        self.updater.inspect_module_install(self.params)
        self.assertEqual(successor.read_bytes(), published)
        # Simulate death after exclusive link but before removing the owned staging alias.
        os.link(successor, pending)
        self.assertEqual(successor.stat().st_nlink, 2)
        self.assertEqual(self.updater.inspect_module_install(self.params)['receipt']['quiescence'], 'confirmed')
        self.assertFalse(pending.exists()); self.assertEqual(successor.stat().st_nlink, 1)
        self.assertEqual(successor.read_bytes(), published)
        params = self.close_params(self.decision(inspected))
        successor.unlink()
        with patch.object(bridge, 'issue_termination_successor', side_effect=AssertionError('finalize minted successor')):
            self.updater.read_install_reconciliation(self.params)
            with self.assertRaises(host.Failure): self.updater.finalize_install_reconciliation(params)
        self.assertFalse(successor.exists()); self.assertFalse((self.directory / 'reconciliation-fence.json').exists())
        # An interrupted prepublication temp is owned metadata; inspect can recover it.
        pending.write_bytes(b'{'); pending.chmod(0o600)
        inspected = self.updater.inspect_module_install(self.params)
        self.assertEqual(inspected['receipt']['quiescence'], 'confirmed'); self.assertFalse(pending.exists())
        valid = successor.read_bytes()
        params = self.close_params(self.decision(inspected))
        for field in ['originalOperationSha256', 'storageBindingSha256', 'ledgerBindingSha256', 'currentSourceCommit']:
            with self.subTest(field=field):
                altered = json.loads(valid); altered['successor'][field] = '0'*(40 if field.endswith('Commit') else 64)
                altered['successorSha256'] = bridge.digest(altered['successor'])
                host.atomic(successor, altered)
                with self.assertRaises(host.Failure): self.updater.finalize_install_reconciliation(params)
                self.assertFalse((self.directory / 'reconciliation-fence.json').exists())
        successor.write_bytes(valid)
        with self.assertRaises(host.Failure):
            self.updater.inspect_module_install({**self.params, 'originalOperationSha256': '0'*64})
        self.current['privateVolume'] = dict(device='0', inode='0')
        with self.assertRaises(host.Failure): self.updater.inspect_module_install(self.params)
        self.current['privateVolume'] = self.volume
        with patch.object(bridge, 'issue_termination_successor', side_effect=AssertionError('finalize minted successor')):
            result = self.updater.finalize_install_reconciliation(params)
        self.assertEqual(result['fence']['action'], 'close_without_activation')
        with patch.object(bridge, 'issue_termination_successor', side_effect=AssertionError('closed intent minted successor')):
            self.assertEqual(self.updater.inspect_module_install(self.params)['receipt']['fence'], 'closed')
        self.assertEqual(successor.read_bytes(), valid)
        for path, original in originals.items(): self.assertEqual(path.read_bytes(), original)
        self.assert_original_untouched()

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

    def test_namespace_change_is_unconfirmed_and_cannot_close_original_intent(self):
        self.operation['worker']['pidNamespace'] = 'different'
        host.atomic(self.directory / 'operation.json', self.operation)
        self.original = (self.directory / 'operation.json').read_bytes()
        self.original_stat = (self.directory / 'operation.json').stat()
        self.params['originalOperationSha256'] = hashlib.sha256(self.original).hexdigest()
        result = self.updater.inspect_module_install(self.params)
        self.assertEqual((result['receipt']['quiescence'], result['receipt']['placement']), ('unconfirmed','unconfirmed'))
        self.updater.catalog = lambda _: {}
        with self.assertRaises(host.Failure): self.updater.finalize_install_reconciliation(self.close_params())
        self.assertTrue(self.updater.operation_pending(self.request)); self.assert_original_untouched()

    def test_explicit_close_fence_preserves_unknown_across_reload_and_validates_client(self):
        self.updater.catalog = lambda _: {}
        params = self.close_params()
        result = self.updater.dispatch(dict(operation='finalizeInstallReconciliation',params=params))
        self.assertEqual(result['fence']['action'], 'close_without_activation')
        reload = service.ModuleUpdater(self.prefix,self.private,self.updater.config,uid=os.getuid())
        self.assertEqual(reload.read_install_reconciliation_fence(self.params),result)
        self.assertFalse(reload.operation_pending(self.request))
        with patch.object(reload,'inspect_current',side_effect=AssertionError('read invoked inspection')):
            self.assertEqual(reload.read_install_reconciliation_fence(self.params),result)
        with self.assertRaises(host.Failure): self.updater.finalize_install_reconciliation(params)
        self.assert_original_untouched()
        script = """
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateInstallReconciliationFence as valid, installReconciliationHash as hash, createContainerUpdateClient } from './src/container-update-client.mjs';
const result=JSON.parse(readFileSync(0,'utf8')); assert.equal(valid(result),true);
assert.equal(createContainerUpdateClient().recoverModuleInstall,undefined);
for (const mutate of [f=>f.force=true,f=>f.action='consume',f=>f.requestId='wrong']) {
  const bad=structuredClone(result); mutate(bad.fence); bad.fenceSha256=hash(bad.fence); assert.equal(valid(bad),false);
}
"""
        subprocess.run(['node','--input-type=module','-e',script],input=json.dumps(result),cwd=ROOT,text=True,check=True,capture_output=True)

    def test_unknown_operation_plan_survives_prune_and_fence_read_needs_no_plan(self):
        self.updater.catalog = lambda _: {}
        result = self.updater.finalize_install_reconciliation(self.close_params())
        plan_path = self.updater.state / 'plans' / (self.plan_id + '.json')
        # A later plan prunes expired plans, but not the expired plan of an unknown operation.
        self.updater.module_target = lambda *_: (_ for _ in ()).throw(host.Failure('FIXTURE_STOP', 409))
        with self.assertRaisesRegex(host.Failure, 'FIXTURE_STOP'):
            self.updater.plan(dict(planId='b62229b1-b119-480b-b3f0-f1d439c02031', catalogSha256='a'*64,
                componentId='execution', versionId='b'*64))
        self.assertTrue(plan_path.exists())
        # Production state of 2026-11-08: the plan was already pruned before this retention existed.
        plan_path.unlink()
        self.assertEqual(self.updater.read_install_reconciliation_fence(self.params), result)
        self.assertFalse(self.updater.operation_pending(self.request))
        self.assert_original_untouched()

    def test_fresh_close_rejects_expiry_changed_proofs_and_apply_already_issued(self):
        self.updater.catalog = lambda _: {}
        mutations = [lambda d:d.update(expiresAt=d['issuedAt']),lambda d:d.pop('ownerGrantRef'),
            lambda d:d.update(targetSha256='0'*64),lambda d:d.update(storageBindingSha256='0'*64),
            lambda d:d.update(runtimeCurrentSha256='0'*64),lambda d:d.update(action='consume')]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                decision=self.decision();mutate(decision['decision']);decision['decisionSha256']=service.reconciliation_hash(decision['decision'])
                # Build the proof before removing the authority field to retain a closed proof.
                params=self.close_params();params['decision']=decision
                with self.assertRaises(host.Failure): self.updater.finalize_install_reconciliation(params)
        params=self.close_params();params['commonProof']['proof']['applyState']='verified'
        params['commonProof']['proof']['applyClaimSha256']='1'*64;params['commonProof']['proof']['resultSha256']='2'*64
        params['commonProof']['proofSha256']=service.reconciliation_hash(params['commonProof']['proof'])
        with self.assertRaises(host.Failure): self.updater.finalize_install_reconciliation(params)
        self.assertFalse((self.directory/'reconciliation-fence.json').exists());self.assert_original_untouched()

    def test_final_close_rechecks_actual_locks_stage_claim_worker_and_placement(self):
        self.updater.catalog=lambda _: {}
        for name in ['worker.lock']:
            params=self.close_params()
            with service.reconciliation_lock(self.updater.state/name,os.getuid()):
                with self.assertRaises(host.Failure):self.updater.finalize_install_reconciliation(params)
        params=self.close_params();stage=self.private/'execution/.staging-other';stage.mkdir(mode=0o700)
        with self.assertRaises(host.Failure):self.updater.finalize_install_reconciliation(params)
        self.assertTrue(stage.exists());stage.rmdir()
        params=self.close_params();claim=self.directory/'recovery-claim.json';host.atomic(claim,{'status':'unknown'})
        with self.assertRaises(host.Failure):self.updater.finalize_install_reconciliation(params)
        claim.unlink()
        params=self.close_params()
        with patch.object(self.updater,'reconciliation_worker_quiescent',side_effect=[None,host.Failure('HOST_UPDATE_BUSY',409)]):
            with self.assertRaises(host.Failure):self.updater.finalize_install_reconciliation(params)
        params=self.close_params()
        with patch.object(self.installer,'inspect_execution_release',side_effect=ValueError('invalid immutable placement')):
            with self.assertRaises(host.Failure):self.updater.finalize_install_reconciliation(params)
        self.assertFalse((self.directory/'reconciliation-fence.json').exists());self.assert_original_untouched()

    def test_lost_close_response_is_same_id_read_only_and_never_a_second_write(self):
        self.updater.catalog=lambda _: {}
        params=self.close_params()
        with patch.object(self.installer,'sync_directory',side_effect=OSError('lost durability response')):
            with self.assertRaises(host.Failure):self.updater.finalize_install_reconciliation(params)
        result=self.updater.read_install_reconciliation_fence(self.params)
        with patch.object(self.installer,'write_file',side_effect=AssertionError('fence reissued')):
            with self.assertRaises(host.Failure):self.updater.finalize_install_reconciliation(params)
        self.assertEqual(self.updater.read_install_reconciliation_fence(self.params),result)
        self.assert_original_untouched()

    def test_valid_fence_only_excludes_its_original_busy_slot_from_normal_start(self):
        self.updater.catalog=lambda _: {};self.updater.inspect=lambda:self.current
        self.updater.planned_target=lambda p:p['target']
        self.updater.launcher=lambda _:(_ for _ in ()).throw(RuntimeError('fixture stops before actual launch'))
        host.atomic(self.updater.state/'module-current.json',dict(current=self.request,previous=None))
        new_request='97209269-7f41-4ac2-a6dc-c6f8611c37a0'
        new_plan={**host.read_json(self.updater.state/'plans'/(self.plan_id+'.json'),os.getuid()),
            'expiresAt':(dt.datetime.now(dt.timezone.utc)+dt.timedelta(minutes=5)).isoformat(),
            'impact':dict(containerRestart=False)}
        new_plan_id='b62229b1-b119-480b-b3f0-f1d439c02031';new_plan['planId']=new_plan_id
        host.atomic(self.updater.state/'plans'/(new_plan_id+'.json'),new_plan)
        start=dict(requestId=new_request,planId=new_plan_id,confirmContainerRestart=False)
        with self.assertRaisesRegex(host.Failure,'HOST_UPDATE_IN_PROGRESS'):self.updater.start(start)
        self.assertFalse((self.updater.state/'operations'/new_request).exists())
        self.updater.finalize_install_reconciliation(self.close_params())
        with self.assertRaisesRegex(host.Failure,'HOST_UPDATE_HANDOFF_UNKNOWN'):self.updater.start(start)
        self.assertTrue((self.updater.state/'operations'/new_request/'operation.json').exists())
        with self.assertRaisesRegex(host.Failure,'HOST_UPDATE_IN_PROGRESS'):
            self.updater.start({**start,'requestId':'5dc2cb96-a1ad-42ce-81e4-78fb2ff4899a'})
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
