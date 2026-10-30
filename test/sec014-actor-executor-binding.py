import importlib.util
import gc
import json
import os
import subprocess
from pathlib import Path
import sys
import time
import unittest
import weakref
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('binding_saved_fixture', ROOT/'test/sec014-saved-prepare.py')
saved = importlib.util.module_from_spec(spec)
spec.loader.exec_module(saved)
a = saved.p.actor


class AfterPrepare(Exception):
    pass


class Binding(saved.SavedPrepare):
    def entry(self, direction, *, saved_normal):
        self.assertEqual(direction, 'to-server')
        self.assertEqual(saved_normal, self.normal)
        return self.f.hold()

    def test_binding_same_held_transaction_executes_saved_prepare(self):
        bound = []
        test = self

        def factory(tx):
            test.tx = tx
            tx.check()
            bound.append(tx)
            test.assertEqual(tx.value['normal']['prepare']['path'], str(test.saved))
            with test.assertRaisesRegex(saved.generation.c.ControlError, 'BUSY'):
                with test.f.hold():
                    pass
            prepare = test.runner()  # Synthetic host authority; fake Docker, real Python clients.
            test.assertIs(prepare.tx, tx)

            class Executor:
                def assert_writers_stopped(self, **fields):
                    return dict(schema='bellteam.sec014.phase-receipt.v1',
                        direction=fields['direction'], image=fields['image'],
                        actorPid=fields['actor_pid'], actorStartTicks=fields['actor_start_ticks'],
                        phase='writers_stopped', status='verified',
                        proofs={key: 'e'*64 for key in a.PROOFS[0]})

                def prepare(self, **fields):
                    test.assertEqual(fields['actor_pid'], tx.value['actorPid'])
                    test.assertEqual(fields['actor_start_ticks'], tx.value['actorStartTicks'])
                    return prepare.prepare()

                def backup_and_migrate(self, **fields):
                    raise AfterPrepare()

                def assert_binds(self, **fields):
                    raise AssertionError('later phase must not run')

                start_selected_normal = verify_result = assert_binds
            return Executor()

        with patch.object(a.control, 'host_control', side_effect=self.entry):
            try:
                a.run_actor('to-server', saved.old.IMAGE, factory, saved_normal=self.normal)
            except AfterPrepare:
                pass
            except Exception as error:
                self.fail('held transaction never reached prepare factory: ' + type(error).__name__)
            else:
                self.fail('synthetic later-phase boundary was not reached')
        self.assertEqual(len(bound), 1)
        self.assertEqual(len(self.commands), 4)
        self.assertEqual(self.commands[0][0][5], str(self.saved))
        journal = self.journal()
        self.assertEqual(journal['phases'], ['writers_stopped', 'prepared'])
        self.assertEqual(journal['status'], 'incomplete')
        self.assertEqual(journal['normal'], bound[0].value['normal'])
        self.assertFalse((self.f.root/'to-server-started.receipt.json').exists())
        with self.assertRaises(OSError):
            os.fstat(bound[0].lock)

    def test_binding_factory_failure_releases_lock_without_advancing(self):
        held = []
        def factory(tx):
            tx.check()
            held.append(tx)
            raise AfterPrepare()
        with patch.object(a.control, 'host_control', side_effect=self.entry):
            with self.assertRaises(AfterPrepare):
                a.run_actor('to-server', saved.old.IMAGE, factory, saved_normal=self.normal)
        self.assertEqual(self.journal()['phases'], [])
        self.assertEqual(self.journal()['status'], 'incomplete')
        self.assertEqual(self.commands, [])
        with self.assertRaises(OSError):
            os.fstat(held[0].lock)

    def prepare_failure_owner(self,birth_missing):
        real_popen=self.real_popen;real_read=Path.read_text;real_save=a._save_json;issued={};invalidated=[]
        def spawn(argv,**kwargs):
            self.assertEqual(argv[0],'/usr/bin/docker')
            child=real_popen([sys.executable,'-c',"import sys;sys.stdout.write('ok')"],
                stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,close_fds=True)
            born=int(real_read(Path(f'/proc/{child.pid}/stat')).rsplit(') ',1)[1].split()[19])
            issued.update(pid=child.pid,born=born,weak=weakref.ref(child))
            end=time.monotonic()+2
            while os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOWAIT|os.WNOHANG) is None:
                if time.monotonic()>=end:self.fail('fixture child did not exit')
                time.sleep(.001)
            return child
        def read(path,*args,**kwargs):
            if birth_missing and issued and path==Path(f"/proc/{issued['pid']}/stat"):
                raise FileNotFoundError('synthetic unobservable issued birth')
            return real_read(path,*args,**kwargs)
        def save(tx,name,value):
            if not birth_missing and name.endswith('-prepare-run.terminal.json'):
                raise OSError('synthetic terminal durability failure')
            return real_save(tx,name,value)
        def factory(tx):
            self.tx=tx
            def host(step):return 'd'*64
            host.invalidate=invalidated.append
            self.runner(host=host).prepare()
            self.fail('unconfirmed Prepare child returned success')
        try:
            with patch.object(saved.p.subprocess,'Popen',side_effect=spawn), \
                    patch.object(Path,'read_text',new=read), \
                    patch.object(a,'_save_json',side_effect=save), \
                    patch.object(a.control,'host_control',side_effect=self.entry):
                try:a.run_actor('to-server',saved.old.IMAGE,factory,saved_normal=self.normal)
                except RuntimeError as error:self.assertEqual(str(error),'SEC014_PREPARE_PHASE_UNCONFIRMED')
                else:self.fail('factory must fail')
            del self.tx
            gc.collect()
            child=issued['weak']()
            try:waitable=os.waitid(os.P_PID,issued['pid'],os.WEXITED|os.WNOWAIT|os.WNOHANG) is not None
            except ChildProcessError:waitable=False
            owned=[tx for tx in a._FAILED_WRITER_OWNERS if tx.path==self.f.root]
            print('PREPARE_UNWIND_OUTPUT '+json.dumps(dict(birthMissing=birth_missing,
                ownerSurvivesGc=child is not None,terminalStillWaitable=waitable,
                failureOwners=len(owned),nativePid=issued['pid'])),flush=True)
            self.assertIsNotNone(child,'Prepare failure lost native child owner')
            self.assertTrue(waitable)
            self.assertEqual(len(owned),1)
            self.assertIs(owned[0]._prepare_children[0][0],child)
            self.assertEqual(owned[0]._prepare_children[0][1],None if birth_missing else issued['born'])
            for fd in (owned[0].parent,owned[0].lock):
                with self.assertRaises(OSError):os.fstat(fd)
            self.assertEqual(set(invalidated),{'UNCONFIRMED_CHILD'})
            self.assertEqual(self.journal()['phases'],[])
            self.assertEqual(self.journal()['status'],'incomplete')
        finally:
            child=issued.get('weak',lambda:None)()
            if child is not None:
                real_popen.wait(child,timeout=2)
                for stream in (child.stdout,child.stderr):
                    if stream and not stream.closed:stream.close()
            a._FAILED_WRITER_OWNERS[:]=[tx for tx in a._FAILED_WRITER_OWNERS if tx.path!=self.f.root]

    def test_prepare_terminal_failure_survives_factory_unwind(self):
        self.prepare_failure_owner(False)

    def test_prepare_unobserved_birth_survives_factory_unwind(self):
        self.prepare_failure_owner(True)

    def host_binding_failure_owner(self,mode):
        issued={};bindings=[];invalidated=[]
        failure=KeyboardInterrupt('synthetic image acquisition interrupted') if mode=='interrupt' else ValueError('synthetic factory failure')
        class Checker:
            def __call__(checker,step):raise AssertionError('host step must not run')
            def bind_image(checker,*args):
                bindings.append(True)
                if mode!='later':raise failure
            def invalidate(checker,reason):
                invalidated.append(reason)
                raise KeyboardInterrupt('synthetic invalidation failed')
        def factory(tx):
            checker=Checker();issued['weak']=weakref.ref(checker)
            with patch.object(type(tx),'_docker_socket_path',self.socket_path):
                saved.p._Prepare(tx,saved.old.IMAGE,saved.old.IMAGE_ID,time.monotonic()+110,
                    saved.old.datetime.now(saved.old.timezone.utc)+saved.old.timedelta(seconds=120),checker)
            raise failure
        try:
            with patch.object(a.control,'host_control',side_effect=self.entry):
                try:a.run_actor('to-server',saved.old.IMAGE,factory,saved_normal=self.normal)
                except BaseException as error:
                    self.assertIs(error,failure)
                    error.__traceback__=error.__context__=error.__cause__=None
                else:self.fail('factory must fail')
            gc.collect()
            checker=issued['weak']()
            owned=[tx for tx in a._FAILED_WRITER_OWNERS if tx.path==self.f.root]
            print('HOST_BINDING_UNWIND '+json.dumps(dict(mode=mode,bindings=len(bindings),
                invalidations=len(invalidated),checkerSurvivesGc=checker is not None,failureOwners=len(owned))),flush=True)
            self.assertIsNotNone(checker,'factory failure lost the unconfirmed host checker')
            self.assertEqual(len(owned),1)
            self.assertEqual(owned[0]._prepare_host_checks,[checker])
            self.assertEqual(bindings,[True])
            self.assertEqual(invalidated,[] if mode=='later' else ['UNCONFIRMED_CHILD'])
            self.assertEqual(self.commands,[])
            self.assertEqual(getattr(owned[0],'_prepare_children',[]),[])
            self.assertEqual(self.journal()['phases'],[])
            self.assertEqual(self.journal()['status'],'incomplete')
            for fd in (owned[0].parent,owned[0].lock):
                with self.assertRaises(OSError):os.fstat(fd)
        finally:
            failure.__traceback__=failure.__context__=failure.__cause__=None
            a._FAILED_WRITER_OWNERS[:]=[tx for tx in a._FAILED_WRITER_OWNERS if tx.path!=self.f.root]

    def test_binding_error_retains_host_checker_after_factory_gc(self):
        self.host_binding_failure_owner('error')

    def test_binding_interrupt_retains_host_checker_after_factory_gc(self):
        self.host_binding_failure_owner('interrupt')

    def test_binding_later_factory_failure_retains_host_checker_after_gc(self):
        self.host_binding_failure_owner('later')

    def test_binding_replaced_generation_after_factory_stops_before_phase(self):
        def factory(tx):
            tx.check()
            replacement = self.saved.with_suffix('.replacement')
            replacement.write_bytes(self.saved.read_bytes())
            replacement.chmod(0o600)
            os.replace(replacement, self.saved)
            return object()
        with patch.object(a.control, 'host_control', side_effect=self.entry):
            with self.assertRaisesRegex(saved.generation.c.ControlError, 'GENERATION'):
                a.run_actor('to-server', saved.old.IMAGE, factory, saved_normal=self.normal)
        self.assertEqual(self.journal()['phases'], [])
        self.assertEqual(self.commands, [])

    def test_binding_invalid_image_never_calls_factory(self):
        calls = []
        def factory(tx):
            calls.append(tx)
            raise AssertionError('invalid image must not construct executor')
        with patch.object(a.control, 'host_control', side_effect=self.entry):
            with self.assertRaisesRegex(a.control.ControlError, 'IMAGE'):
                a.run_actor('to-server', 'latest', factory, saved_normal=self.normal)
        self.assertEqual(calls, [])


if __name__ == '__main__':
    names = sys.argv[1:] or [name for name in dir(Binding) if name.startswith('test_binding_')]
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(Binding(name) for name in names))
    raise SystemExit(not result.wasSuccessful())
