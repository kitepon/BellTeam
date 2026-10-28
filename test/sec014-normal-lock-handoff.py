import fcntl
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
source = Path(os.environ.get('SEC014_HANDOFF_ACTOR_SOURCE',
    str(Path(__file__).resolve().parents[1] / 'distribution/internal/sec014-host-actor.py')))
spec = importlib.util.spec_from_file_location('handoff_actor', source)
actor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(actor)
c = actor.control
SELECTED = {'container_id': 'a' * 64, 'image': 'sha256:' + 'b' * 64, 'token': 'c' * 64}
IMAGE = 'ghcr.io/kitepon/bellteam-server@sha256:' + 'd' * 64


class Handoff(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'control'
        self.path.mkdir(mode=0o750)
        self.path.chmod(0o750)
        self.owner = os.getuid(), os.getgid()

    def hold(self, direction='to-server'):
        return c._hold(self.path, direction, self.owner, normal_group=os.getgid())

    def prerequisites(self, tx):
        for phase in ('writers_stopped', 'prepared', 'migrated', 'binds_confirmed'):
            tx.confirmed(phase)

    def test_readonly_normal_lock_outlives_actor_and_receipts_remain_private(self):
        with self.hold() as tx:
            normal = os.open(self.path / 'sec014.lock', os.O_RDONLY)
            self.addCleanup(os.close, normal)
            with self.assertRaises(BlockingIOError):
                fcntl.flock(normal, fcntl.LOCK_SH | fcntl.LOCK_NB)
            self.prerequisites(tx)
            tx.admit_normal(**SELECTED)
            fcntl.flock(normal, fcntl.LOCK_SH | fcntl.LOCK_NB)
            value = dict(schema='bellteam.sec014.phase-receipt.v1', direction='to-server',
                         phase='started', image=IMAGE, actorPid=tx.value['actorPid'],
                         actorStartTicks=tx.value['actorStartTicks'], status='verified',
                         proofs={p: 'e' * 64 for p in actor.PROOFS[4]})
            actor._receipt(tx, 'started', IMAGE, value, actor.PROOFS[4])
            tx.confirmed('started'); tx.confirmed('verified')
            self.assertEqual((self.path / 'sec014.lock').stat().st_mode & 0o777, 0o640)
            self.assertEqual((self.path / tx.name).stat().st_mode & 0o777, 0o640)
            self.assertEqual((self.path / 'to-server-started.receipt.json').stat().st_mode & 0o777, 0o600)
            self.assertEqual((self.path / 'sec014.lock').read_text(), 'to-server\n')
        with self.assertRaisesRegex(c.ControlError, 'BUSY'):
            with self.hold('to-legacy'): pass
        fcntl.flock(normal, fcntl.LOCK_UN)
        with self.hold('to-legacy'): pass

    def test_publication_requires_prerequisites_valid_selection_and_durable_save(self):
        with self.hold() as tx:
            with self.assertRaisesRegex(c.ControlError, 'HANDOFF_PHASE'):
                tx.admit_normal(**SELECTED)
            self.prerequisites(tx)
            for field in SELECTED:
                bad = dict(SELECTED, **{field: 'wrong'})
                with self.assertRaisesRegex(c.ControlError, 'HANDOFF_SELECTION'):
                    tx.admit_normal(**bad)
            with self.assertRaisesRegex(c.ControlError, 'HANDOFF_REQUIRED'):
                tx.confirmed('started')
            with patch.object(tx, '_save', side_effect=OSError('synthetic-save')):
                with self.assertRaises(OSError): tx.admit_normal(**SELECTED)
            normal = os.open(self.path / 'sec014.lock', os.O_RDONLY)
            try:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(normal, fcntl.LOCK_SH | fcntl.LOCK_NB)
            finally: os.close(normal)
        saved = json.loads((self.path / 'transaction-to-server.json').read_text())
        self.assertIsNone(saved['admission'])
        self.assertEqual(saved['status'], 'incomplete')

    def test_conversion_gap_competing_actor_cannot_write_or_replace_journal(self):
        real = fcntl.flock
        with self.hold() as tx:
            self.prerequisites(tx)
            def conversion(fd, operation):
                if fd == tx.lock and operation == fcntl.LOCK_SH | fcntl.LOCK_NB:
                    real(fd, fcntl.LOCK_UN)
                    before = (self.path / tx.name).read_bytes()
                    self.assertIsNotNone(json.loads(before)['admission'])
                    with self.assertRaisesRegex(c.ControlError, 'UNRESOLVED'):
                        with self.hold('to-legacy'): pass
                    self.assertEqual((self.path / tx.name).read_bytes(), before)
                    self.assertFalse((self.path / 'transaction-to-legacy.json').exists())
                return real(fd, operation)
            with patch.object(c.fcntl, 'flock', side_effect=conversion):
                tx.admit_normal(**SELECTED)
            self.assertTrue(tx.shared)

    def test_parent_death_preserves_closed_or_published_incomplete_journal(self):
        for published in (False, True):
            if published:
                (self.path / 'transaction-to-server.json').unlink()
            pid = os.fork()
            if pid == 0:
                try:
                    with self.hold() as tx:
                        self.prerequisites(tx)
                        if published: tx.admit_normal(**SELECTED)
                        os._exit(0)
                except BaseException: os._exit(1)
            _, status = os.waitpid(pid, 0)
            self.assertEqual(os.waitstatus_to_exitcode(status), 0)
            saved = json.loads((self.path / 'transaction-to-server.json').read_text())
            self.assertEqual(saved['admission'] is not None, published)
            self.assertEqual(saved['status'], 'incomplete')
            with self.assertRaisesRegex(c.ControlError, 'UNRESOLVED'):
                with self.hold('to-legacy'): pass

    def test_fixed_actor_checks_writers_before_prepare_and_publishes_before_start(self):
        calls = []
        with self.hold() as tx:
            class Executor:
                def prepare_selected_normal(self, **fields):
                    calls.append('select')
                    return dict(SELECTED)
                def __getattr__(self, method):
                    phase_by_method = dict(zip(('assert_writers_stopped', 'prepare', 'backup_and_migrate',
                        'assert_binds', 'start_selected_normal', 'verify_result'), c.PHASES))
                    phase = phase_by_method[method]
                    def run(**fields):
                        calls.append(method)
                        if phase == 'started':
                            if not tx.shared or tx.value['admission']['containerId'] != SELECTED['container_id']:
                                raise AssertionError('start before handoff')
                        if phase in ('started', 'verified'):
                            if fields['selected_normal'] != tx.value['admission']:
                                raise AssertionError('selected identity not passed to start/result')
                        return dict(schema='bellteam.sec014.phase-receipt.v1', direction='to-server',
                            phase=phase, image=fields['image'], actorPid=fields['actor_pid'],
                            actorStartTicks=fields['actor_start_ticks'], status='verified',
                            proofs={p: 'e' * 64 for p in actor.PROOFS[c.PHASES.index(phase)]})
                    return run
            actor._run(tx, IMAGE, Executor())
        self.assertEqual(calls, ['assert_writers_stopped', 'prepare', 'backup_and_migrate',
                                'assert_binds', 'select', 'start_selected_normal', 'verify_result'])
        self.assertEqual(json.loads((self.path / 'transaction-to-server.json').read_text())['status'], 'completed')


if __name__ == '__main__': unittest.main(verbosity=2)
