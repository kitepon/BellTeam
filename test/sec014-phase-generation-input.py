import importlib.util
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('phase_generation_fixture', ROOT/'test/sec014-control-generation.py')
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
a = g.a


class PhaseGeneration(g.Generations):
    def test_every_phase_receives_the_exact_held_saved_generation(self):
        normal = self.normal('aaaaaa')
        calls = []
        case = self
        with self.hold(normal) as tx:
            original = self.executor()  # Synthetic receipts, real filesystem/transaction lock.
            class Executor:
                def __getattr__(self, name):
                    method = getattr(original, name)
                    def run(**fields):
                        case.assertEqual(fields.get('saved_normal'), tx.value['normal'], name)
                        case.assertEqual(fields['saved_normal']['path'], str(normal))
                        tx.check()
                        calls.append(name)
                        return method(**fields)
                    return run
            a._run(tx, g.IMAGE, Executor())
            self.assertEqual(tx.value['phases'], list(a.control.PHASES))
        self.assertEqual(calls, ['assert_writers_stopped', 'prepare', 'backup_and_migrate',
            'assert_binds', 'prepare_selected_normal', 'start_selected_normal', 'verify_result'])


if __name__ == '__main__':
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite([
        PhaseGeneration('test_every_phase_receives_the_exact_held_saved_generation')]))
    raise SystemExit(not result.wasSuccessful())
