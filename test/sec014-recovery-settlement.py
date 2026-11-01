import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('generation_fixture',ROOT/'test/sec014-control-generation.py')
g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
a,c=g.a,g.c


class Settlement(g.Generations):
    def child(self,live=False):
        child=subprocess.Popen([sys.executable,'-c','import sys;sys.stdin.buffer.read()'],stdin=subprocess.PIPE)
        def close_child():
            if not child.stdin.closed:child.stdin.close()
            child.wait(timeout=2)
        self.addCleanup(close_child)
        born=int(Path(f'/proc/{child.pid}/stat').read_text().rsplit(') ',1)[1].split()[19])
        if not live:close_child()
        return child,born

    def prior(self,tx,live=False):
        child,born=self.child(live)
        return dict(tx.value,actorPid=child.pid,actorStartTicks=born)

    def save(self,tx,name,value):
        return a._save_json(tx,'to-server-internal-1-query.'+name+'.json',value)

    def client(self,tx,argv=None,code=0,terminal=True,live=False,spawn=True):
        child,born=self.child(live)
        argv=argv or ['/usr/bin/docker','inspect','fixture']
        self.save(tx,'claim',dict(argv=argv,image=tx.value['normal']['image'],imageId=tx.value['normal']['image']))
        if spawn:self.save(tx,'spawn',dict(pid=child.pid,startTicks=born))
        if terminal:self.save(tx,'output',dict(argv=argv,clientPid=child.pid,clientStartTicks=born,unknown=False,terminal=dict(kind='exit',code=code)))
        return child,born

    def test_dead_actor_and_known_readonly_failure_are_finite(self):
        with self.hold(self.normal('aaaaaa')) as tx:
            prior=self.prior(tx)
            self.client(tx,code=1)
            proof=a._settled_prior(tx,prior)
            self.assertEqual(proof['actor'],'absent')
            self.assertEqual(len(proof['clients']),1)
            self.assertTrue(proof['clients'][0]['readonly'])
            self.assertEqual(tx.value['phases'],[])

    def test_live_old_actor_is_not_a_recovery_permission(self):
        with self.hold(self.normal('aaaaaa')) as tx:
            prior=self.prior(tx,live=True)
            with self.assertRaisesRegex(c.ControlError,'STILL_LIVE'):a._settled_prior(tx,prior)

    def test_live_client_is_unknown_despite_a_terminal_record(self):
        with self.hold(self.normal('aaaaaa')) as tx:
            prior=self.prior(tx)
            self.client(tx,live=True)
            with self.assertRaisesRegex(c.ControlError,'STILL_LIVE'):a._settled_prior(tx,prior)

    def test_missing_spawn_or_terminal_cannot_clear_an_incomplete_attempt(self):
        for missing in ('spawn','terminal'):
            fixture=Settlement();fixture.setUp()
            try:
                with fixture.hold(fixture.normal('aaaaaa')) as tx:
                    prior=fixture.prior(tx)
                    fixture.client(tx,spawn=missing!='spawn',terminal=missing!='terminal')
                    with self.assertRaisesRegex(c.ControlError,'CLIENT_UNKNOWN'):a._settled_prior(tx,prior)
                    self.assertEqual(tx.value['phases'],[])
            finally:fixture.doCleanups()

    def test_nonzero_mutation_and_nonhealth_exec_remain_unknown(self):
        for argv in (['/usr/bin/docker','start','d'*64],['/usr/bin/docker','exec','d'*64,'/usr/local/bin/node','-e','arbitrary()']):
            fixture=Settlement();fixture.setUp()
            try:
                with fixture.hold(fixture.normal('aaaaaa')) as tx:
                    prior=fixture.prior(tx);fixture.client(tx,argv=argv,code=1)
                    with self.assertRaisesRegex(c.ControlError,'EFFECT_UNKNOWN'):a._settled_prior(tx,prior)
            finally:fixture.doCleanups()

    def test_saved_real_health_program_failure_is_readonly(self):
        with self.hold(self.normal('aaaaaa')) as tx:
            prior=self.prior(tx)
            self.client(tx,argv=['/usr/bin/docker','exec','--user','1001:1001','d'*64,'/usr/local/bin/node','-e',a.HEALTH_PROGRAM],code=1)
            self.assertTrue(a._settled_prior(tx,prior)['clients'][0]['readonly'])

    def test_different_process_birth_is_not_the_recorded_client(self):
        child,born=self.child(live=True)
        self.assertEqual(a._process_finished(child.pid,born+1),'reused')
        with self.assertRaisesRegex(c.ControlError,'STILL_LIVE'):a._process_finished(child.pid,born)


if __name__=='__main__':
    suite=unittest.TestSuite(Settlement(name) for name in Settlement.__dict__ if name.startswith('test_'))
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(not result.wasSuccessful())
