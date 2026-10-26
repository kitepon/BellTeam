import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('new_consumer_fixture', ROOT / 'test/sec014-host-parent-consumer.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class ImageBindingCounter(unittest.TestCase):
    def test_other_image_parent_binding_must_refuse_before_prepare_child(self):
        f = fixture.ConsumerTests()
        f.setUp()
        self.addCleanup(f.doCleanups)
        original = fixture.c.host._raw
        other_ref = 'ghcr.io/kitepon/bellteam-server@sha256:' + 'e' * 64
        other_id = 'sha256:' + 'f' * 64

        def other_image_input(value):
            if isinstance(value, dict) and 'sourcePins' in value:
                value.update(image=other_id, imageRef=other_ref)
            return original(value)

        receipt, failure = None, None
        with f.f.f.hold() as tx:
            with patch.object(fixture.c.host, '_raw', side_effect=other_image_input):
                try:
                    consumer = f.consumer(tx)
                    receipt = f.prepare(tx, consumer)
                except Exception as error:
                    failure = type(error).__name__
            print({'parentImageRef': f.binding['imageRef'],
                   'prepareImageRef': fixture.fixture.IMAGE,
                   'receiptReturned': receipt is not None,
                   'dedicatedPythonClients': len(f.f.commands),
                   'failure': failure,
                   'journalPhases': f.f.journal()['phases']}, flush=True)
        self.assertEqual(f.f.commands, [], 'a parent proof for another image must not admit prepare')
        self.assertIsNotNone(failure)
        self.assertIsNone(receipt)


if __name__ == '__main__':
    unittest.main(verbosity=2)
