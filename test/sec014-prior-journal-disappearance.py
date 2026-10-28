"""An opened incomplete journal disappearing at linked stat must fail closed."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
source = Path(__file__).resolve().parents[1] / 'distribution/internal/sec014-host-control.py'
spec = importlib.util.spec_from_file_location('control_counterexample', source)
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class PriorJournalDisappearance(unittest.TestCase):
    def test_opened_incomplete_journal_lost_before_linked_stat_blocks_new_direction(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary) / 'control'
            parent.mkdir(mode=0o700)
            owner = os.getuid(), os.getgid()
            with c._hold(parent, 'to-server', owner):
                pass
            original_stat = c.os.stat
            moved = False

            def stat_after_rename(path, *args, **kwargs):
                nonlocal moved
                if path == 'transaction-to-server.json' and kwargs.get('dir_fd') is not None and not moved:
                    moved = True
                    os.rename(path, 'retained-incomplete.json',
                              src_dir_fd=kwargs['dir_fd'], dst_dir_fd=kwargs['dir_fd'])
                return original_stat(path, *args, **kwargs)

            yielded = False
            try:
                with patch.object(c.os, 'stat', stat_after_rename):
                    with c._hold(parent, 'to-legacy', owner):
                        yielded = True
            except c.ControlError:
                pass
            finally:
                print(json.dumps({
                    'raceTriggered': moved,
                    'oldJournalStatus': json.loads((parent / 'retained-incomplete.json').read_text())['status'],
                    'newDirectionYielded': yielded,
                    'newJournalCreated': (parent / 'transaction-to-legacy.json').exists(),
                    'DockerCalls': 0,
                }, sort_keys=True))
            self.assertFalse(yielded, 'opened incomplete journal was treated as initially absent')


if __name__ == '__main__':
    unittest.main(verbosity=2)
