import fcntl
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('recovery_inputs_fixture',ROOT/'test/sec014-recovery-inputs.py')
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
a,c=f.a,f.c


class RecoveryControl(f.RecoveryInputs):
    def prior(self,layout='legacy'):
        normal=self.inputs(layout)
        with self.hold(normal):pass
        process=subprocess.Popen([sys.executable,'-c','import sys;sys.stdin.buffer.read()'],stdin=subprocess.PIPE)
        born=int(Path(f'/proc/{process.pid}/stat').read_text().rsplit(') ',1)[1].split()[19])
        process.stdin.close();process.wait(timeout=2)
        path=self.control/'transaction-to-server.json'
        value=json.loads(path.read_text());value.update(actorPid=process.pid,actorStartTicks=born)
        path.write_text(json.dumps(value));path.chmod(0o640)
        self.before=(path.read_bytes(),path.stat().st_ino)
        return normal,path

    def recover(self,normal):
        return a._recovery_hold(self.control,self.owner,os.getgid(),normal)

    def test_same_ex_and_original_journal_survive_an_unfinished_recovery(self):
        normal,prior=self.prior()
        with self.recover(normal) as tx:
            self.assertFalse(tx.shared)
            self.assertEqual(tx.value['schema'],'bellteam.sec014.host-recovery.v1')
            self.assertEqual(tx.value['layout'],'legacy')
            self.assertIsNone(tx.value['admission'])
            self.assertEqual(tx.value['normal'],c._normal(normal))
            probe=subprocess.run([sys.executable,'-c','import fcntl,os,sys;f=os.open(sys.argv[1],os.O_RDWR);fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)',str(self.control/'sec014.lock')],capture_output=True)
            self.assertNotEqual(probe.returncode,0)
            tx.check()
        self.assertEqual((prior.read_bytes(),prior.stat().st_ino),self.before)
        self.assertEqual(json.loads((self.control/'recovery-to-legacy.json').read_text())['status'],'incomplete')
        with self.assertRaisesRegex(c.ControlError,'ALREADY_RECORDED'):
            with self.recover(normal):pass
        with self.assertRaises(c.ControlError):
            with self.hold(normal):pass

    def test_before_first_actor_has_no_invented_prior_or_token(self):
        normal=self.inputs()
        with self.recover(normal) as tx:
            self.assertIsNone(tx.value['priorJournal'])
            proof=c._saved(tx.parent,'to-legacy-prior-settlement.json',self.owner)
            self.assertEqual(proof['actor'],'not-issued')
            self.assertEqual(proof['clients'],[])
        self.assertFalse((self.control/'transaction-to-server.json').exists())

    def test_orphan_forward_claim_is_not_a_never_issued_actor(self):
        normal=self.inputs()
        path=self.control/'to-server-native.claim.json';path.write_text('{}');path.chmod(0o600)
        with self.assertRaisesRegex(c.ControlError,'RECOVERY_PRIOR'):
            with self.recover(normal):pass
        self.assertFalse((self.control/'recovery-to-legacy.json').exists())

    def test_existing_shared_holder_blocks_recovery(self):
        normal,prior=self.prior()
        lock=os.open(self.control/'sec014.lock',os.O_RDWR)
        try:
            fcntl.flock(lock,fcntl.LOCK_SH|fcntl.LOCK_NB)
            with self.assertRaisesRegex(c.ControlError,'BUSY'):
                with self.recover(normal):pass
        finally:os.close(lock)
        self.assertFalse((self.control/'recovery-to-legacy.json').exists())
        self.assertEqual((prior.read_bytes(),prior.stat().st_ino),self.before)

    def test_live_prior_actor_preserves_every_original_and_issues_nothing(self):
        normal=self.inputs()
        with self.hold(normal):pass
        path=self.control/'transaction-to-server.json';before=path.read_bytes(),path.stat().st_ino
        with self.assertRaisesRegex(c.ControlError,'STILL_LIVE'):
            with self.recover(normal):pass
        self.assertEqual((path.read_bytes(),path.stat().st_ino),before)
        self.assertFalse((self.control/'recovery-to-legacy.json').exists())

    def test_legacy_completion_keeps_ex_without_ordinary_admission(self):
        normal,prior=self.prior()
        with self.recover(normal) as tx:
            for phase in c.PHASES:tx.confirmed(phase)
            self.assertEqual(tx.value['status'],'completed')
            self.assertIsNone(tx.value['admission'])
            self.assertFalse(tx.shared)
            self.assertFalse((self.control/'transaction-to-legacy.json').exists())
        self.assertEqual((prior.read_bytes(),prior.stat().st_ino),self.before)

    def test_controlled_old_normal_gets_actual_token_and_existing_consumer_format(self):
        normal,prior=self.prior('server')
        with self.recover(normal) as tx:
            for phase in c.PHASES[:4]:tx.confirmed(phase)
            old=tx.value['previousNormal']
            with self.assertRaises(c.ControlError):tx.admit_normal('d'*64,old['image'],'f'*64)
            tx.admit_normal('d'*64,old['image'],old['token'])
            self.assertTrue(tx.shared)
            conventional=json.loads((self.control/'transaction-to-legacy.json').read_text())
            self.assertEqual(conventional['schema'],c.SCHEMA)
            self.assertEqual(conventional['normal'],old)
            self.assertEqual(conventional['admission'],dict(containerId='d'*64,image=old['image'],token=old['token']))
            self.assertEqual(conventional['phases'],list(c.PHASES[:4]))
            tx.confirmed('started');tx.confirmed('verified')
            self.assertEqual(json.loads((self.control/'transaction-to-legacy.json').read_text())['status'],'completed')
        self.assertEqual((prior.read_bytes(),prior.stat().st_ino),self.before)

    def test_changed_saved_pair_is_checked_during_recovery(self):
        normal,prior=self.prior()
        with self.recover(normal) as tx:
            raw=self.original.read_bytes();self.original.write_bytes(raw+b' ')
            with self.assertRaisesRegex(c.ControlError,'GENERATION_CHANGED'):tx.check()
        self.assertEqual((prior.read_bytes(),prior.stat().st_ino),self.before)


if __name__=='__main__':
    suite=unittest.TestSuite(RecoveryControl(name) for name in RecoveryControl.__dict__ if name.startswith('test_'))
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(not result.wasSuccessful())
