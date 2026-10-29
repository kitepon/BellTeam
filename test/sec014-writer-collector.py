import importlib.util
import gc
import weakref
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('held_writer_fixture', ROOT/'test/sec014-held-writer-config.py')
h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)


class WriterCollector(h.HeldWriterConfig):
    def run_factory(self, mode):
        normal, _ = self.pair()
        native = ROOT/'distribution/internal/sec014-writer-collector.py'
        self.assertTrue(native.exists(), 'fixed native writer producer is missing')
        spec = importlib.util.spec_from_file_location('writer_collector', native)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        self.children = []
        self.waited = []
        self.addCleanup(self.cleanup_children)
        real_popen = subprocess.Popen
        outside = self.root/'outside'; outside.mkdir()
        backing = outside/'volume'; backing.mkdir()
        alias = self.root/'alias'; alias.symlink_to(self.root/'legacy')
        (self.root/'legacy').mkdir()
        cid = 'e'*64
        container = dict(id=cid, running=True, restarting=False, restartPolicy='no',
            mounts=[dict(Type='volume', Name='foreign_volume', Source=str(backing), RW=True)])
        if mode in ('writer','missing'):
            container['mounts'] = [dict(Type='bind', Source=str(alias if mode=='writer' else self.root/'absent-observed'), RW=True)]
        def spawn(argv, **kwargs):
            if argv[0] != '/usr/bin/docker':
                return real_popen(argv, **kwargs)
            self.assertNotIn('.Config.Env', ' '.join(argv))
            self.assertEqual(set(kwargs['env']), {'PATH', 'HOME', 'LANG', 'DOCKER_CONFIG'})
            self.assertEqual(list(Path(kwargs['env']['DOCKER_CONFIG']).iterdir()), [])
            if argv[1:3] == ['container', 'ls']:
                self.assertEqual(argv, ['/usr/bin/docker','container','ls','--all','--quiet','--no-trunc'])
                raw = (cid+'\n').encode() if mode != 'overflow' else b'x'*8321
            elif argv[1] == 'inspect':
                self.assertEqual(argv[-1], cid)
                raw = (json.dumps(container)+'\n').encode()
            else:
                self.assertEqual(argv[1:4], ['volume','inspect','--format'])
                self.assertEqual(argv[-1], 'foreign_volume')
                raw = json.dumps(dict(name='foreign_volume',driver='local',mountpoint=str(backing),
                    optionCount=0,type=None,device=None,options=None)).encode()
            program='import sys;sys.stdout.buffer.write(bytes.fromhex('+repr(raw.hex())+'));sys.exit('+('7' if mode=='nonzero' else '0')+')'
            child = real_popen([sys.executable,'-c',program],
                cwd=self.root, env=kwargs['env'], stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True)
            self.children.append(child)
            wait = child.wait
            def reap(timeout=None):
                observation = self.control/'to-server-writer-observation.json'
                self.assertTrue(observation.exists(), 'verification and persistence must precede native reap')
                records=json.loads(observation.read_text())['terminalRefs']
                for record in records:
                    if record['clientPid'] in self.waited: continue
                    observed=int(Path(f"/proc/{record['clientPid']}/stat").read_text().rsplit(') ',1)[1].split()[19])
                    self.assertEqual(observed,record['clientStartTicks'])
                self.assertIsNotNone(os.waitid(os.P_PID, child.pid, os.WEXITED|os.WNOWAIT|os.WNOHANG))
                self.waited.append(child.pid)
                return wait(timeout=timeout)
            child.wait = reap
            return child
        result = []
        def factory(tx):
            collector = module._Writer(tx,h.g.IMAGE,h.g.SELECTED['image'],time.monotonic()+30,
                datetime.now(timezone.utc)+timedelta(seconds=40))
            class Executor:
                def assert_writers_stopped(inner, **fields):
                    result.append(collector.snapshot())
                    raise RuntimeError('STOP_METADATA_ONLY')
                def __getattr__(inner, name):
                    self.fail('no later phase may run: '+name)
            # _run resolves all phase method names before calling phase zero.
            executor = Executor()
            for name in ('prepare','backup_and_migrate','assert_binds','start_selected_normal','verify_result'):
                setattr(executor,name,lambda **fields: self.fail('later phase executed'))
            return executor
        expected = 'STOP_METADATA_ONLY' if mode == 'success' else 'SEC014_WRITER_HELD_OR_UNKNOWN'
        read_text=Path.read_text
        def read(path,*args,**kwargs):
            if mode=='birth_missing' and self.children and path==Path(f'/proc/{self.children[0].pid}/stat'):
                raise FileNotFoundError('synthetic missing native birth')
            return read_text(path,*args,**kwargs)
        with patch.object(module.subprocess,'Popen',side_effect=spawn), patch.object(module.Path,'read_text',new=read), patch.object(h.g.c,'host_control',side_effect=lambda direction,saved_normal:self.hold(saved_normal)):
            with self.assertRaisesRegex(RuntimeError,expected):
                h.g.a.run_actor('to-server',h.g.IMAGE,factory,saved_normal=normal)
        journal=json.loads((self.control/'transaction-to-server.json').read_text())
        self.assertEqual(journal['phases'],[])
        self.assertEqual(journal['status'],'incomplete')
        print('WRITER_NATIVE_OUTPUT '+json.dumps({'mode':mode,'scope':'dedicated Python clients with fake Docker protocol; no Docker daemon',
            'nativePids':[child.pid for child in self.children],'reapedPids':self.waited,
            'files':{p.name:p.read_text() for p in self.control.glob('to-server-writer-*json')}}),flush=True)
        return result

    def cleanup_children(self):
        for child in self.children:
            subprocess.Popen.wait(child,timeout=2)
            for stream in (child.stdout,child.stderr):
                if stream and not stream.closed: stream.close()

    def test_factory_native_terminals_consumed_before_reap(self):
        result = self.run_factory('success')[0]
        self.assertFalse(result['hostWriterAuthorityVerified'])
        self.assertFalse(result['phaseReceiptProduced'])
        self.assertEqual(len(self.children),3)
        self.assertEqual(len(self.waited),3)
        self.assertEqual({x['clientPid'] for x in result['terminalRefs']},{x.pid for x in self.children})
        self.assertTrue(all(not Path(f'/proc/{x.pid}').exists() for x in self.children))
        for path in self.control.glob('to-server-writer-*json'):
            self.assertEqual(path.stat().st_mode & 0o777,0o600)

    def test_running_real_alias_stops_before_receipt_or_reap(self):
        self.run_factory('writer')
        self.assertEqual(len(self.children),2)
        self.assertEqual(self.waited,[])
        self.assertFalse((self.control/'to-server-writer-observation.json').exists())
        self.assertTrue((self.control/'to-server-writer-unknown.json').exists())

    def test_list_cap_stops_before_inspection(self):
        self.run_factory('overflow')
        self.assertEqual(len(self.children),1)
        self.assertEqual(self.waited,[])
        self.assertFalse((self.control/'to-server-writer-observation.json').exists())

    def test_nonzero_terminal_is_saved_without_retry_or_reap(self):
        self.run_factory('nonzero')
        self.assertEqual(len(self.children),1)
        self.assertEqual(self.waited,[])
        record=json.loads((self.control/'to-server-writer-list.terminal.json').read_text())
        self.assertEqual(record['terminal'],{'kind':'exit','code':7})

    def test_missing_observed_path_is_not_treated_as_planned(self):
        self.run_factory('missing')
        self.assertEqual(len(self.children),2)
        self.assertEqual(self.waited,[])
        self.assertFalse((self.control/'to-server-writer-observation.json').exists())

    def test_missing_birth_keeps_issued_pid_as_unknown(self):
        self.run_factory('birth_missing')
        self.assertEqual(len(self.children),1)
        self.assertEqual(self.waited,[])
        unknown=json.loads((self.control/'to-server-writer-unknown.json').read_text())
        self.assertEqual(unknown['clients'],[{'pid':self.children[0].pid,'startTicks':None}])


    def test_failure_survives_factory_unwind_without_test_child_owner(self):
        normal, _ = self.pair()
        spec=importlib.util.spec_from_file_location('unwind_writer',ROOT/'distribution/internal/sec014-writer-collector.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        real_popen=subprocess.Popen
        issued={}
        def spawn(argv,**kwargs):
            if argv[0]!='/usr/bin/docker':return real_popen(argv,**kwargs)
            child=real_popen([sys.executable,'-c',"import sys;sys.stdout.write('x'*8321)"],
                stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,close_fds=True)
            issued.update(pid=child.pid,weak=weakref.ref(child))
            limit=time.monotonic()+2
            while os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOWAIT|os.WNOHANG) is None:
                if time.monotonic()>=limit:self.fail('fixture child failed to exit')
                time.sleep(.001)
            return child
        def factory(tx):
            collector=module._Writer(tx,h.g.IMAGE,h.g.SELECTED['image'],time.monotonic()+30,
                datetime.now(timezone.utc)+timedelta(seconds=40))
            collector.snapshot()  # Fail inside the factory, before an executor can be returned.
            self.fail('overflow must stop factory')
        try:
            with patch.object(module.subprocess,'Popen',side_effect=spawn),patch.object(h.g.c,'host_control',side_effect=lambda direction,saved_normal:self.hold(saved_normal)):
                try:h.g.a.run_actor('to-server',h.g.IMAGE,factory,saved_normal=normal)
                except RuntimeError as error:self.assertIn('SEC014_WRITER_HELD_OR_UNKNOWN',str(error))
                else:self.fail('unconfirmed client must fail')
            gc.collect()  # No exception/traceback or test Popen reference survives this point.
            self.assertIsNotNone(issued['weak'](), 'failure owner lost the native client after factory unwind')
            self.assertIsNotNone(os.waitid(os.P_PID,issued['pid'],os.WEXITED|os.WNOWAIT|os.WNOHANG))
            journal=json.loads((self.control/'transaction-to-server.json').read_text())
            self.assertEqual(journal['phases'],[])
            self.assertEqual(journal['status'],'incomplete')
            print('WRITER_UNWIND_OUTPUT '+json.dumps({'pid':issued['pid'],'ownerSurvivesGc':True,
                'terminalStillWaitable':True,'phaseReceipt':False,'scope':'ordinary dedicated Python child, no Docker'}),flush=True)
        finally:
            # Explicit local-fixture teardown, not an automatic production failure path.
            child=issued.get('weak',lambda:None)()
            if child is not None:
                real_popen.wait(child,timeout=2)
                for stream in (child.stdout,child.stderr):
                    if stream and not stream.closed:stream.close()
            owners=getattr(h.g.a,'_FAILED_WRITER_OWNERS',[])
            owners[:]=[tx for tx in owners if tx.path!=self.control]


if __name__ == '__main__':
    names=[name for name in WriterCollector.__dict__ if name.startswith('test_')]
    result=unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(WriterCollector(name) for name in names))
    raise SystemExit(not result.wasSuccessful())
