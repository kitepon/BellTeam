import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('prepared_proof',
    Path(__file__).resolve().parents[1]/'distribution/internal/sec014-prepared-proof.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class PreparedProofTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)/'state-data'
        self.root.mkdir(mode=0o700)
        self.owner = (os.getuid(), os.getgid())
        parent = self.root.stat()
        self.value = {'schema': 'bellteam.state-directories.v1',
                      'parent': {'device': str(parent.st_dev), 'inode': str(parent.st_ino)},
                      'leaves': []}
        for name in p.LEAVES:
            path = self.root/name
            path.mkdir(mode=0o711)
            info = path.stat()
            self.value['leaves'].append({'name': name, 'device': str(info.st_dev),
                                         'inode': str(info.st_ino)})
        receipt = self.root/'.prepared.json'
        receipt.write_text(json.dumps(self.value))
        receipt.chmod(0o600)

    def read(self):
        return p._read(self.root, self.owner, self.owner)

    def test_current_six_leaf_metadata_without_reading_contents(self):
        (self.root/'apns'/'untouched').write_text('synthetic-not-a-key')
        with patch.object(Path, 'read_bytes', side_effect=AssertionError('content read')):
            value = json.loads(self.read())
        self.assertEqual([leaf['name'] for leaf in value['leaves']], list(p.LEAVES))
        self.assertEqual(value['schema'], 'bellteam.sec014.prepared-proof.v1')

    def test_wrong_mode_and_recorded_identity_are_not_prepared(self):
        for mutate in ['mode', 'identity']:
            with self.subTest(mutate=mutate):
                if mutate == 'mode': (self.root/'state').chmod(0o700)
                else:
                    (self.root/'state').chmod(0o711)
                    self.value['leaves'][0]['inode'] = '0'
                    (self.root/'.prepared.json').write_text(json.dumps(self.value))
                with self.assertRaises(p.control.ControlError): self.read()

    def test_equal_bytes_receipt_replacement_after_read_refused(self):
        original = p.control._saved
        def replace(*args):
            value = original(*args)
            path = self.root/'.prepared.json'
            path.rename(self.root/'.retained-receipt')
            path.write_text(json.dumps(value))
            path.chmod(0o600)
            return value
        with patch.object(p.control, '_saved', side_effect=replace):
            with self.assertRaisesRegex(p.control.ControlError, 'CHANGED'): self.read()

    def test_leaf_replacement_after_open_refused_and_fds_closed(self):
        original = p.os.stat
        def replace(name, *args, **kwargs):
            if name == 'apns':
                (self.root/'apns').rename(self.root/'.retained-apns')
                (self.root/'apns').mkdir(mode=0o711)
            return original(name, *args, **kwargs)
        before = set(os.listdir('/proc/self/fd'))
        with patch.object(p.os, 'stat', side_effect=replace):
            with self.assertRaisesRegex(p.control.ControlError, 'CHANGED'): self.read()
        self.assertEqual(set(os.listdir('/proc/self/fd')), before)


if __name__ == '__main__': unittest.main(verbosity=2)
