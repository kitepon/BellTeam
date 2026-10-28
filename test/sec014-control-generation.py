import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
source = Path(os.environ.get('SEC014_GENERATION_ACTOR_SOURCE', str(
    Path(__file__).resolve().parents[1] / 'distribution/internal/sec014-host-actor.py')))
spec = importlib.util.spec_from_file_location('generation_actor', source)
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
c = a.control
IMAGE = 'ghcr.io/kitepon/bellteam-server@sha256:' + 'a' * 64
SELECTED = {'container_id': 'b' * 64, 'image': 'sha256:' + 'c' * 64, 'token': 'd' * 64}


class Generations(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.control = self.root / 'control'
        self.control.mkdir(mode=0o750)
        self.control.chmod(0o750)
        self.owner = os.getuid(), os.getgid()

    def normal(self, suffix):
        parent = self.root / ('.bellteam-compose.' + suffix)
        parent.mkdir(mode=0o700)
        path = parent / 'normal.json'
        path.write_text(json.dumps({'name': 'bellteam', 'services': {
            'bellteam': {'image': IMAGE, 'volumes': []}}}))
        path.chmod(0o600)
        return path

    def hold(self, normal):
        return c._hold(self.control, 'to-server', self.owner,
                       normal_group=os.getgid(), saved_normal=normal)

    def executor(self):
        class Executor:
            def prepare_selected_normal(self, **fields):
                return dict(SELECTED)

            def __getattr__(self, name):
                index = ('assert_writers_stopped', 'prepare', 'backup_and_migrate',
                         'assert_binds', 'start_selected_normal', 'verify_result').index(name)

                def run(**fields):
                    return dict(schema='bellteam.sec014.phase-receipt.v1',
                        direction=fields['direction'], phase=c.PHASES[index],
                        image=fields['image'], actorPid=fields['actor_pid'],
                        actorStartTicks=fields['actor_start_ticks'], status='verified',
                        proofs={key: 'e' * 64 for key in a.PROOFS[index]})
                return run
        return Executor()

    def complete(self, normal):
        with self.hold(normal) as tx:
            a._run(tx, IMAGE, self.executor())

    def test_repeated_update_retains_original_journal_receipt_bytes_and_inodes(self):
        first, second, third = (self.normal(x) for x in ('aaaaaa', 'bbbbbb', 'cccccc'))
        self.complete(first)
        before = {p.name: (p.read_bytes(), p.stat().st_ino)
                  for p in self.control.iterdir() if p.name != 'sec014.lock'}
        lock_inode = (self.control / 'sec014.lock').stat().st_ino
        self.complete(second)
        history = first.parent / 'sec014-control-history'
        for name, (raw, inode) in before.items():
            self.assertEqual((history / name).read_bytes(), raw)
            self.assertEqual((history / name).stat().st_ino, inode)
        self.assertEqual((history.stat().st_mode & 0o777), 0o700)
        with self.assertRaisesRegex(c.ControlError, 'GENERATION'):
            with self.hold(first): pass
        self.complete(third)
        self.assertTrue((second.parent / 'sec014-control-history/transaction-to-server.json').exists())
        self.assertEqual((self.control / 'sec014.lock').stat().st_ino, lock_inode)
        self.assertEqual((self.control / 'sec014.lock').read_text(), 'to-server\n')

    def test_incomplete_generation_is_never_archived_or_overwritten(self):
        first, second = self.normal('aaaaaa'), self.normal('bbbbbb')
        with self.hold(first) as tx:
            tx.confirmed('writers_stopped')
        before = (self.control / 'transaction-to-server.json').read_bytes()
        with self.assertRaisesRegex(c.ControlError, 'UNRESOLVED'):
            with self.hold(second): pass
        self.assertEqual((self.control / 'transaction-to-server.json').read_bytes(), before)
        self.assertFalse((first.parent / 'sec014-control-history').exists())

    def test_changed_normal_and_reused_generation_preserve_old_history(self):
        first, second = self.normal('aaaaaa'), self.normal('bbbbbb')
        self.complete(first)
        with self.assertRaisesRegex(c.ControlError, 'GENERATION'):
            with self.hold(first): pass
        raw = first.read_bytes()
        first.write_bytes(raw + b' ')
        with self.assertRaisesRegex(c.ControlError, 'GENERATION'):
            with self.hold(second): pass
        first.write_bytes(raw)
        # A pre-existing history must never be overwritten even when empty.
        (first.parent / 'sec014-control-history').mkdir(mode=0o700)
        with self.assertRaisesRegex(c.ControlError, 'GENERATION'):
            with self.hold(second): pass
        self.assertEqual((self.control / 'sec014.lock').read_text(), 'to-server\n')

    def test_interrupted_archive_refuses_next_actor_and_preserves_every_inode(self):
        first, second = self.normal('aaaaaa'), self.normal('bbbbbb')
        self.complete(first)
        before = {p.name: (p.read_bytes(), p.stat().st_ino)
                  for p in self.control.iterdir() if p.name != 'sec014.lock'}
        real = c.os.rename
        calls = 0
        def fail_after_one(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2: raise OSError('synthetic interruption')
            return real(*args, **kwargs)
        with patch.object(c.os, 'rename', side_effect=fail_after_one):
            with self.assertRaises(OSError):
                with self.hold(second): pass
        with self.assertRaisesRegex(c.ControlError, 'UNRESOLVED'):
            with self.hold(second): pass
        for name, (raw, inode) in before.items():
            locations = [p for p in (self.control / name,
                first.parent / 'sec014-control-history' / name) if p.exists()]
            self.assertEqual(len(locations), 1)
            self.assertEqual(locations[0].read_bytes(), raw)
            self.assertEqual(locations[0].stat().st_ino, inode)

    def test_saved_config_boundary_and_actual_actor_entry_passes_same_generation(self):
        first = self.normal('aaaaaa')
        first.chmod(0o644)
        with self.assertRaises(c.ControlError):
            with self.hold(first): pass
        self.assertFalse((self.control / 'transaction-to-server.json').exists())
        first.chmod(0o600)
        def entry(direction, *, saved_normal):
            self.assertEqual(direction, 'to-server')
            self.assertEqual(saved_normal, first)
            return self.hold(saved_normal)
        with patch.object(c, 'host_control', side_effect=entry):
            a.run_actor('to-server', IMAGE, self.executor(), saved_normal=first)
        saved = json.loads((self.control / 'transaction-to-server.json').read_text())
        self.assertEqual(saved['normal']['path'], str(first))

    def test_replaced_old_generation_during_archive_cannot_receive_root_writes(self):
        first, second = self.normal('aaaaaa'), self.normal('bbbbbb')
        self.complete(first)
        original = c._selector
        old_raw = first.read_bytes()
        def replace_after_marker(lock, direction):
            original(lock, direction)
            if direction == 'archiving':
                first.parent.rename(self.root / 'retained-original')
                first.parent.mkdir(mode=0o700)
                first.write_bytes(old_raw)
                first.chmod(0o600)
        with patch.object(c, '_selector', side_effect=replace_after_marker):
            with self.assertRaisesRegex(c.ControlError, 'GENERATION'):
                with self.hold(second): pass
        self.assertFalse((first.parent / 'sec014-control-history').exists())
        self.assertTrue((self.control / 'transaction-to-server.json').exists())
        with self.assertRaisesRegex(c.ControlError, 'UNRESOLVED'):
            with self.hold(second): pass


if __name__ == '__main__': unittest.main()
