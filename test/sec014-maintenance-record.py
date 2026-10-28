import hashlib
import importlib.util
import json
import os
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('generation_fixture', ROOT / 'test/sec014-control-generation.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class MaintenanceRecord(m.Generations):
    def pair(self):
        normal = self.normal('aaaaaa')
        path = normal.parent / 'compose.state-maintenance.json'
        path.write_text(json.dumps({'name': 'deployment-project', 'services': {
            'state-maintenance': {'image': m.SELECTED['image'], 'volumes': []}}}))
        path.chmod(0o600)
        return normal, path

    def test_held_record_includes_same_maintenance_file(self):
        normal, path = self.pair()
        with self.hold(normal) as tx:
            record = tx.value['normal'].get('maintenance')
            self.assertIsNotNone(record)
            self.assertEqual(record['path'], str(path))
            self.assertEqual(record['sha256'], hashlib.sha256(path.read_bytes()).hexdigest())
            self.assertEqual(record['inode'], path.stat().st_ino)
            self.assertEqual(record['parentInode'], normal.parent.stat().st_ino)
            self.assertEqual(record['service'], json.loads(path.read_text())['services']['state-maintenance'])
            self.assertEqual(record['image'], tx.value['normal']['image'])
            tx.check()

    def test_same_bytes_replacement_is_rejected(self):
        normal, path = self.pair()
        with self.hold(normal) as tx:
            replacement = path.with_suffix('.replacement')
            replacement.write_bytes(path.read_bytes())
            replacement.chmod(0o600)
            os.replace(replacement, path)
            with self.assertRaises(m.c.ControlError):
                tx.check()

    def test_changed_raw_model_is_rejected(self):
        normal, path = self.pair()
        with self.hold(normal) as tx:
            model = json.loads(path.read_text())
            model['services']['state-maintenance']['volumes'].append({'target': '/changed'})
            path.write_text(json.dumps(model))
            with self.assertRaises(m.c.ControlError):
                tx.check()

    def test_different_selected_image_is_rejected(self):
        normal, path = self.pair()
        model = json.loads(path.read_text())
        model['services']['state-maintenance']['image'] = 'sha256:' + 'f' * 64
        path.write_text(json.dumps(model))
        with self.assertRaises(m.c.ControlError):
            with self.hold(normal):
                pass

    def test_symlink_is_rejected(self):
        normal, path = self.pair()
        target = path.with_suffix('.copy')
        path.rename(target)
        path.symlink_to(target)
        with self.assertRaises(m.c.ControlError):
            with self.hold(normal):
                pass

    def test_previous_normal_keeps_its_own_image(self):
        normal, path = self.pair()
        previous = normal.with_name('previous-normal.json')
        model = json.loads(normal.read_text())
        model['services']['bellteam']['image'] = 'sha256:' + 'f' * 64
        previous.write_text(json.dumps(model))
        previous.chmod(0o600)
        record = m.c._normal(previous)
        self.assertNotIn('maintenance', record)
        self.assertEqual(record['image'], 'sha256:' + 'f' * 64)


if __name__ == '__main__':
    names = [name for name in MaintenanceRecord.__dict__ if name.startswith('test_')]
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(
        MaintenanceRecord(name) for name in names))
    raise SystemExit(not result.wasSuccessful())
