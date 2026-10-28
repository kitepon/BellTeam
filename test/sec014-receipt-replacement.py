"""An immutable receipt's written inode must survive readback, even for equal JSON."""
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('actor_fixture', Path(__file__).with_name('sec014-host-actor.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
a = fixture.a


class ReceiptReplacement(unittest.TestCase):
    def test_equal_json_receipt_substitution_cannot_advance_or_start(self):
        case = fixture.ActorTests()
        case.setUp()
        self.addCleanup(case.doCleanups)
        original = a.control._saved
        swapped = []

        def read_after_substitution(parent, name, owner):
            if name.endswith('.receipt.json') and not swapped:
                path = case.root / name
                raw, before = path.read_bytes(), path.stat()
                path.rename(case.root / 'retained-written-receipt.json')
                path.write_bytes(raw)
                path.chmod(0o600)
                after = path.stat()
                swapped.append({'sameBytes': raw == path.read_bytes(),
                                'differentInode': (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino)})
            return original(parent, name, owner)

        refused = False
        with case.hold() as tx:
            with patch.object(a.control, '_saved', read_after_substitution):
                try:
                    a._run(tx, fixture.IMAGE, case.executor())
                except a.control.ControlError:
                    refused = True
        journal = json.loads((case.root / 'transaction-to-server.json').read_text())
        print(json.dumps({'swapped': swapped, 'refused': refused,
                          'journalStatus': journal['status'], 'journalPhases': journal['phases'],
                          'normalStartCalls': case.calls.count('start_selected_normal'),
                          'actualDocker': 0, 'actualRoot': False}, sort_keys=True))
        self.assertNotIn('start_selected_normal', case.calls, 'replacement receipt advanced journal to normal start')


if __name__ == '__main__':
    unittest.main(verbosity=2)
