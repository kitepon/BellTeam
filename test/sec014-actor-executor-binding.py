import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest
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
