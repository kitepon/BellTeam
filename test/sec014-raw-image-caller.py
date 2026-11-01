import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('raw_saved_fixture', ROOT/'test/sec014-saved-prepare.py')
saved = importlib.util.module_from_spec(spec)
spec.loader.exec_module(saved)


class RawCaller(saved.SavedPrepare):
    def setUp(self):
        super().setUp()
        model = json.loads(self.normal.read_text())
        model.pop('x-bellteam-image-ref')
        self.normal.write_text(json.dumps(model))
        self.model.pop('x-bellteam-image-ref')
        self.write_model()

    def test_raw_saved_prepare_reaches_native_commands_and_receipt(self):
        with patch.object(saved.old, 'IMAGE', saved.old.IMAGE_ID):
            with self.f.hold() as self.tx:
                receipt = self.runner().prepare()
                self.assertEqual(receipt['image'], saved.old.IMAGE_ID)
                self.assertEqual(len(self.commands), 4)
                self.assertEqual(self.commands[0][1]['BELLTEAM_SERVER_IMAGE'], saved.old.IMAGE_ID)
                claim = json.loads((self.f.root/'to-server-prepare-run.claim.json').read_text())
                self.assertEqual((claim['image'], claim['imageId']), (saved.old.IMAGE_ID, saved.old.IMAGE_ID))
                self.assertEqual(self.journal()['phases'], [])

    def test_raw_actor_factory_and_all_phase_inputs_keep_same_selection(self):
        seen = []
        def entry(direction, *, saved_normal):
            self.assertEqual(saved_normal, self.normal)
            return self.f.hold()
        def factory(tx):
            seen.append(tx.value['normal']['image'])
            return self.g.executor()
        with patch.object(saved.old, 'IMAGE', saved.old.IMAGE_ID), \
                patch.dict(saved.generation.SELECTED, image=saved.old.IMAGE_ID), \
                patch.object(saved.p.actor.control, 'host_control', side_effect=entry):
            result = saved.p.actor.run_actor('to-server', saved.old.IMAGE_ID, factory, saved_normal=self.normal)
        self.assertEqual(seen, [saved.old.IMAGE_ID])
        self.assertEqual([row['phase'] for row in result], list(saved.p.actor.control.PHASES))
        self.assertEqual(self.journal()['status'], 'completed')
        for phase in saved.p.actor.control.PHASES:
            receipt = json.loads((self.f.root/('to-server-'+phase+'.receipt.json')).read_text())
            self.assertEqual(receipt['image'], saved.old.IMAGE_ID)

    def test_raw_pair_mismatch_refuses_before_host_binding_or_command(self):
        with patch.object(saved.old, 'IMAGE', 'sha256:'+'f'*64):
            with self.f.hold() as self.tx:
                with self.assertRaisesRegex(saved.p.actor.control.ControlError, 'SCOPE'):
                    self.runner()
                self.assertEqual(self.commands, [])


if __name__ == '__main__':
    names = [name for name in RawCaller.__dict__ if name.startswith('test_')]
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(RawCaller(name) for name in names))
    raise SystemExit(not result.wasSuccessful())
