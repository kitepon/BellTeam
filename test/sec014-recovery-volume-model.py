import importlib.util
import json
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('volume_recovery_fixture',ROOT/'test/sec014-internal-recovery.py')
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
a=f.a


class VolumeModel(f.Recovery):
    def pair(self):
        super().pair()
        model=self.previous_model
        mount=next(v for v in model['services']['bellteam']['volumes'] if v['target']=='/home/bell/.local')
        before=mount['source'];mount['source']='original_cursor_alias'
        model['volumes']['original_cursor_alias']=model['volumes'].pop(before)
        self.previous.write_text(json.dumps(model));self.previous.chmod(0o600)
        self.previous_original=self.previous.read_bytes(),self.previous.stat().st_ino

    def old_mounts(self):
        mounts=super().old_mounts()
        if self.recovery_mutation=='wrong-observed-volume':
            for mount in mounts:
                if mount['Type']=='volume':mount['Name']='different_actual_volume'
        return mounts

    def verify_alias(self):
        self.execute_recovery()
        self.assertTrue(self.started)
        self.assertEqual((self.previous.read_bytes(),self.previous.stat().st_ino),self.previous_original)
        self.assertEqual(self.previous_model['volumes']['original_cursor_alias']['name'],'fixture_cursor')
        self.assertNotIn('original_cursor_alias',self.normal_model['volumes'])
        self.assertEqual(json.loads((self.g.control/'recovery-to-legacy.json').read_text())['status'],'completed')

    def test_legacy_old_symbolic_alias_uses_its_own_volume_model(self):
        self.verify_alias()

    def test_controlled_server_alias_preserves_actual_volume_and_original_bytes(self):
        self.layout='server';self.controlled=True;self.verify_alias()
        self.assertTrue(self.tx.shared)

    def test_old_alias_still_refuses_a_different_observed_volume_before_start(self):
        self.recovery_mutation='wrong-observed-volume'
        with self.assertRaisesRegex(a.control.ControlError,'SELECTED_MOUNTS'):self.execute_recovery()
        self.assertFalse(self.started)


if __name__=='__main__':
    suite=unittest.TestSuite(VolumeModel(name) for name in VolumeModel.__dict__ if name.startswith('test_'))
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(not result.wasSuccessful())
