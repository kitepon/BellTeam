import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('inspection_fixture',ROOT/'test/module-install-reconciliation.test.py')
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
api=fixture.service;host=api.host
bridge=api.load_module('bridge_test','module-worker-termination.py')

class WorkerBridge(unittest.TestCase):
    decision=fixture.ReconciliationInspection.decision
    close_params=fixture.ReconciliationInspection.close_params
    assert_original_untouched=fixture.ReconciliationInspection.assert_original_untouched
    def setUp(self):
        fixture.ReconciliationInspection.setUp(self);self.loader.stop()
        self.loader=patch.object(api,'load_module',side_effect=lambda name,filename:bridge if filename=='module-worker-termination.py' else self.installer)
        self.loader.start()
        self.operation['worker']['pidNamespace']='111'
        host.atomic(self.directory/'operation.json',self.operation)
        self.updater.config['release']='b'*40;self.current['sourceCommit']='b'*40
        self.original=(self.directory/'operation.json').read_bytes();self.original_stat=(self.directory/'operation.json').stat()
        self.params['originalOperationSha256']=hashlib.sha256(self.original).hexdigest()
        self.project='bridge-test';self.cid='d'*64;self.image='sha256:'+'e'*64
        self.old=dict(status='running',dead=False,id=self.cid,image='sha256:'+'f'*64,started='2026-11-04T10:00:00Z',finished='0001-01-01T00:00:00Z',running=True,restarting=False,pid=1234,exitCode=0,
            entrypoint=['/usr/bin/python3','-I','-B','/app/scripts/module-update-service.py'],user='0:0',restart='unless-stopped',pidMode='',readOnly=True,privileged=False,project=self.project,service='module-installer',mounts=[
                dict(Destination='/srv/bellteam-module-updater',Type='volume',Name=self.project+'-module-updater',RW=True),
                dict(Destination='/srv/bellteam-private',Type='volume',Name='private',RW=True),dict(Destination='/run/bellteam-updater',Type='volume',Name=self.project+'-module-socket',RW=True)])
        self.actions=[];self.fail=None;self.ns='111';self.worker_birth=None
        self.switch=bridge.Switch(api,self.updater,self.project,self.image,'private',self.command)
        host.atomic(self.updater.state/'module-current.json',dict(current=self.request,previous=None))

    def command(self,args,data=None):
        self.actions.append(args)
        if args[:2]==['container','ls']:return (self.cid+'\n').encode()
        if args[:2]==['container','inspect']:return json.dumps(self.old).encode()
        if args[:2]==['volume','inspect']:return json.dumps(dict(Name=args[-1],Driver='local',Options=None)).encode()
        if args[0]=='exec':return json.dumps(dict(pidNamespace=self.ns,sourceCommit='a'*40,births=[self.worker_birth])).encode()
        if args[:2]==['container','update']:self.old['restart']='no';return b''
        if args[:2]==['container','stop']:
            if self.fail=='stop':raise TimeoutError('unknown stop response')
            self.old.update(status='exited',running=False,pid=0,finished=host.stamp());return b''
        if args[:2]==['container','wait']:return b'0\n'
        if args[:2]==['container','rm']:return b''
        raise AssertionError(args)

    def bridge_success(self):
        self.switch.switch()
        self.assert_original_untouched()
        record=host.read_json(self.directory/'worker-termination.json',os.getuid())
        self.assertEqual(record['prepare']['oldService']['containerId'],self.cid)
        self.assertEqual(record['prepare']['worker'],self.operation['worker'])
        self.assertEqual(record['termination']['status'],'stopped')
        self.assertEqual(sum(a[:2]==['container','stop'] for a in self.actions),1)
        return record

    def test_bridge_complete_stop_then_cross_namespace_inspection_and_close(self):
        record=self.bridge_success()
        result=self.updater.inspect_module_install(self.params)
        self.assertEqual((result['receipt']['quiescence'],result['receipt']['placement']),('confirmed','absent'))
        self.updater.catalog=lambda _:{}
        self.updater.finalize_install_reconciliation(self.close_params())
        self.assertFalse(self.updater.operation_pending(self.request));self.assert_original_untouched()
        self.assertIn(['container','wait',self.cid],self.actions)

    def test_bridge_namespace_worker_stage_and_busy_refuse_before_stop(self):
        self.ns='999'
        with self.assertRaises(host.Failure):self.switch.switch()
        self.ns='111';self.worker_birth=self.operation['worker']['birth']
        with self.assertRaises(host.Failure):self.switch.switch()
        self.worker_birth=None
        stage=self.private/'execution/.staging-unowned';stage.mkdir(mode=0o700)
        with self.assertRaises(host.Failure):self.switch.switch()
        stage.rmdir()
        with self.assertRaises(host.Failure):
            with api.reconciliation_lock(self.updater.state/'worker.lock',os.getuid()):self.switch.switch()
        self.assertFalse(any(a[:2]==['container','stop'] for a in self.actions))
        self.assertFalse((self.directory/'worker-termination-prepare.json').exists());self.assert_original_untouched()

    def test_bridge_lost_stop_is_read_only_no_new_prepare_or_stop(self):
        self.fail='stop'
        with self.assertRaises(TimeoutError):self.switch.switch()
        prepare=(self.directory/'worker-termination-prepare.json').read_bytes()
        self.fail=None
        with self.assertRaises((host.Failure,FileNotFoundError)):self.switch.switch()
        self.assertEqual((self.directory/'worker-termination-prepare.json').read_bytes(),prepare)
        self.assertEqual(sum(a[:2]==['container','stop'] for a in self.actions),1)
        self.assertEqual(self.updater.inspect_module_install(self.params)['receipt']['quiescence'],'unconfirmed')
        self.assert_original_untouched()

    def test_bridge_complete_record_response_loss_can_read_without_repeated_stop(self):
        self.bridge_success();before=sum(a[:2]==['container','stop'] for a in self.actions)
        self.switch.switch()
        self.assertEqual(sum(a[:2]==['container','stop'] for a in self.actions),before)
        self.assert_original_untouched()

    def test_bridge_record_hash_binding_and_root_trust_refuse(self):
        record=self.bridge_success();path=self.directory/'worker-termination.json'
        original=path.read_bytes()
        for field,value in [('originalOperationSha256','0'*64),('planSha256','0'*64),('ledgerBinding',dict(device='0',inode='0'))]:
            invalid=copy.deepcopy(record);invalid['prepare'][field]=value
            invalid['prepareSha256']=bridge.digest(invalid['prepare']);invalid['termination']['prepareSha256']=invalid['prepareSha256'];invalid['terminationSha256']=bridge.digest(invalid['termination'])
            host.atomic(path,invalid)
            self.assertEqual(self.updater.inspect_module_install(self.params)['receipt']['quiescence'],'unconfirmed')
        path.write_bytes(original);path.chmod(0o666)
        self.assertEqual(self.updater.inspect_module_install(self.params)['receipt']['quiescence'],'unconfirmed')
        path.chmod(0o600);self.assert_original_untouched()

    def test_bridge_read_receipt_and_evidence_commitment_are_pure(self):
        record=self.bridge_success();count=len(self.actions)
        with patch.object(self.updater,'inspect_module_install',side_effect=AssertionError('reader must not inspect')):
            observed=bridge.read_receipt(api,self.updater,self.request)
        self.assertEqual(observed['receiptSha256'],bridge.digest(record))
        self.assertEqual(observed['oldContainerId'],self.cid);self.assertEqual(len(self.actions),count)
        actual=self.updater.inspect_module_install(self.params)['receipt']
        expected=api.reconciliation_hash(dict(current=self.current,target=self.target,planSha256=actual['planSha256'],
            placement='absent',manifestSha256=None,stageState='clear',recoveryState='not_issued',fence='open',workerTerminationSha256=bridge.digest(record)))
        self.assertEqual(actual['evidenceSha256'],expected);self.assertEqual(len(actual),20)
        self.assert_original_untouched()

    def test_bridge_prepare_alone_blocks_even_if_namespace_still_matches(self):
        self.operation['worker']['pidNamespace']=str(os.stat('/proc/self/ns/pid').st_ino)
        host.atomic(self.directory/'operation.json',self.operation)
        self.original=(self.directory/'operation.json').read_bytes();self.original_stat=(self.directory/'operation.json').stat()
        self.params['originalOperationSha256']=hashlib.sha256(self.original).hexdigest()
        host.atomic(self.directory/'worker-termination-prepare.json',dict(status='unknown'))
        self.assertEqual(self.updater.inspect_module_install(self.params)['receipt']['quiescence'],'unconfirmed')
        self.assert_original_untouched()

    def test_bridge_prepare_fsync_uncertain_refuses_before_stop(self):
        with patch.object(self.installer,'sync_directory',side_effect=OSError('durability unknown')):
            with self.assertRaises(OSError):self.switch.switch()
        self.assertFalse(any(a[:2]==['container','stop'] for a in self.actions))
        self.assertFalse((self.directory/'worker-termination.json').exists())
        self.assertEqual(self.updater.inspect_module_install(self.params)['receipt']['quiescence'],'unconfirmed')
        self.assert_original_untouched()

    def test_bridge_wrong_final_identity_never_writes_complete_receipt(self):
        original=self.switch.command
        def command(args,data=None):
            result=original(args,data)
            if args[:2]==['container','stop']:self.old['started']='2026-11-04T12:00:00Z'
            return result
        self.switch.command=command
        with self.assertRaises(host.Failure):self.switch.switch()
        self.assertFalse((self.directory/'worker-termination.json').exists())
        self.assertFalse(any(a[:2]==['container','rm'] for a in self.actions));self.assert_original_untouched()

    def test_bridge_missing_old_service_with_unknown_refuses_and_fresh_install_skips(self):
        self.switch.command=lambda args,data=None:b'' if args[:2]==['container','ls'] else self.command(args,data)
        with self.assertRaises(host.Failure):self.switch.switch()
        fresh_prefix=self.root/'fresh';fresh_prefix.mkdir(mode=0o700);(fresh_prefix/'state').mkdir(mode=0o700)
        fresh=api.ModuleUpdater(fresh_prefix,self.private,self.updater.config,uid=os.getuid())
        calls=[]
        def empty(args,data=None):calls.append(args);return b''
        bridge.Switch(api,fresh,self.project,self.image,'private',empty).switch()
        self.assertEqual(len(calls),1);self.assertEqual(calls[0][:2],['container','ls'])
        self.assertFalse((fresh.state/'worker.lock').exists());self.assert_original_untouched()

    def test_bridge_removed_old_container_resumes_only_from_complete_durable_record(self):
        record=self.bridge_success();before=len(self.actions)
        def absent(args,data=None):
            self.assertEqual(args[:2],['container','ls']);return b''
        self.switch.command=absent;self.switch.switch()
        self.assertEqual(len(self.actions),before);self.assert_original_untouched()
        (self.directory/'worker-termination.json').unlink()
        with self.assertRaises((FileNotFoundError,host.Failure)):self.switch.switch()
        self.assertEqual(len(self.actions),before)

if __name__=='__main__':unittest.main()
