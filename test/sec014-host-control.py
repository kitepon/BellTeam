import importlib.util
import json
import os
from pathlib import Path
import tempfile
import sys
sys.dont_write_bytecode = True
import unittest

source = Path(__file__).resolve().parents[1] / 'distribution/internal/sec014-host-control.py'
spec = importlib.util.spec_from_file_location('sec014_control', source)
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class HostControlTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / 'control'
        self.path.mkdir(mode=0o700)
        self.owner = os.getuid(), os.getgid()

    def hold(self, direction='to-server'):
        return c._hold(self.path, direction, self.owner)

    def test_same_lock_held_through_all_phases_and_reverse(self):
        with self.hold() as tx:
            self.assertFalse(os.get_inheritable(tx.lock))
            self.assertFalse(os.get_inheritable(tx.parent))
            for phase in c.PHASES:
                with self.assertRaisesRegex(c.ControlError, 'BUSY'):
                    with self.hold('to-legacy'): pass
                tx.confirmed(phase)
        with self.hold('to-legacy') as tx:
            for phase in c.PHASES: tx.confirmed(phase)
        with self.assertRaisesRegex(c.ControlError, 'ALREADY_RECORDED'):
            with self.hold(): pass

    def test_normal_return_leaves_unresolved_journal(self):
        with self.hold(): pass
        self.assertEqual(json.loads((self.path/'transaction-to-server.json').read_text())['status'], 'incomplete')
        with self.assertRaisesRegex(c.ControlError, 'UNRESOLVED'):
            with self.hold('to-legacy'): pass

    def test_inherited_transaction_rejects_another_native_actor(self):
        with self.hold() as tx:
            read_fd, write_fd = os.pipe()
            pid = os.fork()
            if pid == 0:
                os.close(read_fd)
                try:
                    tx.check()
                    result = b'accepted'
                except c.ControlError as error:
                    result = str(error).encode()
                except BaseException:
                    result = b'unexpected failure'
                try:
                    os.write(write_fd, result)
                finally:
                    os._exit(0)
            os.close(write_fd)
            try:
                observed = os.read(read_fd, 128)
            finally:
                os.close(read_fd)
                _, status = os.waitpid(pid, 0)
            self.assertEqual(status, 0)
            self.assertEqual(observed, b'SEC014_CONTROL_ACTOR_IDENTITY')
            tx.check()
            born = tx.value['actorStartTicks']
            tx.value['actorStartTicks'] = born + 1
            try:
                with self.assertRaisesRegex(c.ControlError, 'ACTOR_IDENTITY'):
                    tx.check()
            finally:
                tx.value['actorStartTicks'] = born
            tx.check()
            self.assertEqual(json.loads((self.path/'transaction-to-server.json').read_text())['phases'], [])

    def test_completed_looking_partial_journal_is_not_a_receipt(self):
        p = self.path/'transaction-to-server.json'
        p.write_text(json.dumps({'direction': 'to-server', 'status': 'completed', 'phases': list(c.PHASES)}))
        p.chmod(0o600)
        with self.assertRaisesRegex(c.ControlError, 'UNRESOLVED'):
            with self.hold('to-legacy'): pass

    def test_lock_substitution_prevents_next_phase(self):
        with self.hold() as tx:
            (self.path/'sec014.lock').rename(self.path/'old-lock')
            (self.path/'sec014.lock').touch(mode=0o600)
            with self.assertRaisesRegex(c.ControlError, 'IDENTITY_CHANGED'):
                tx.confirmed(c.PHASES[0])

    def test_parent_substitution_and_phase_order_rejected(self):
        with self.hold() as tx:
            with self.assertRaisesRegex(c.ControlError, 'PHASE_ORDER'):
                tx.confirmed('verified')
            self.path.rename(self.path.parent/'previous')
            self.path.mkdir(mode=0o700)
            with self.assertRaisesRegex(c.ControlError, 'IDENTITY_CHANGED'):
                tx.confirmed(c.PHASES[0])

    def test_symlink_hardlink_wrong_owner_or_mode_refused(self):
        lock = self.path/'sec014.lock'
        target = self.path/'target'; target.touch(mode=0o600)
        lock.symlink_to(target)
        with self.assertRaises(OSError):
            with self.hold(): pass
        lock.unlink(); os.link(target, lock)
        with self.assertRaisesRegex(c.ControlError, 'METADATA'):
            with self.hold(): pass
        lock.unlink(); lock.touch(mode=0o644)
        with self.assertRaisesRegex(c.ControlError, 'METADATA'):
            with self.hold(): pass
        lock.chmod(0o600)
        with self.assertRaisesRegex(c.ControlError, 'METADATA'):
            with c._hold(self.path, 'to-server', (self.owner[0]+1, self.owner[1])): pass

    @unittest.skipIf(os.getuid() == 0, 'requires an actual non-root caller')
    def test_public_entry_rejects_nonroot_before_host_access(self):
        with self.assertRaisesRegex(c.ControlError, 'ROOT_REQUIRED'):
            with c.host_control('to-server', saved_normal=Path('/unused/normal.json')): pass

    def test_parent_death_lock_release_is_not_completion(self):
        read_fd, write_fd = os.pipe()
        pid = os.fork()
        if pid == 0:
            os.close(read_fd)
            with self.hold():
                os.write(write_fd, b'1')
                os._exit(0)
        os.close(write_fd)
        try: self.assertEqual(os.read(read_fd, 1), b'1')
        finally: os.close(read_fd)
        os.waitpid(pid, 0)
        with self.assertRaisesRegex(c.ControlError, 'UNRESOLVED'):
            with self.hold('to-legacy'): pass


if __name__ == '__main__': unittest.main()
