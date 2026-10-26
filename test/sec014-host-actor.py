import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

path = Path(__file__).resolve().parents[1]/'distribution/internal/sec014-host-actor.py'
spec = importlib.util.spec_from_file_location('sec014_actor', path)
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
IMAGE = 'ghcr.io/kitepon/bellteam-server@sha256:' + 'a'*64


class ActorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)/'control'
        self.root.mkdir(mode=0o700)
        self.calls = []
        self.receipts = []

    def hold(self, direction='to-server'):
        return a.control._hold(self.root, direction, (os.getuid(), os.getgid()))

    def executor(self, mutate=lambda value: value):
        test = self

        class Executor:
            def __getattr__(self, name):
                names = ('prepare', 'assert_writers_stopped', 'backup_and_migrate',
                         'assert_binds', 'start_selected_normal', 'verify_result')
                index = names.index(name)

                def phase(**fields):
                    # The real kernel lock is held throughout every phase.
                    with test.assertRaisesRegex(a.control.ControlError, 'BUSY'):
                        with test.hold('to-legacy'): pass
                    test.calls.append(name)
                    value = dict(schema='bellteam.sec014.phase-receipt.v1',
                                 direction=fields['direction'], image=fields['image'],
                                 actorPid=fields['actor_pid'], actorStartTicks=fields['actor_start_ticks'],
                                 phase=a.control.PHASES[index], status='verified',
                                 proofs={p: 'b'*64 for p in a.PROOFS[index]})
                    value = mutate(value)
                    test.receipts.append(copy.deepcopy(value))
                    return value
                return phase
        return Executor()

    def test_fixed_sequence_receipts_durable_before_journal_and_reverse(self):
        with self.hold() as tx:
            result = a._run(tx, IMAGE, self.executor())
        self.assertEqual([x['phase'] for x in result], list(a.control.PHASES))
        self.assertEqual(len(list(self.root.glob('to-server-*.receipt.json'))), 6)
        self.assertEqual(json.loads((self.root/'transaction-to-server.json').read_text())['status'], 'completed')
        with self.hold('to-legacy') as tx:
            a._run(tx, IMAGE, self.executor())
        self.assertTrue(all(r['direction']=='to-legacy' for r in self.receipts[6:]))
        self.assertEqual(len(self.calls), 12)

    def test_unverified_phase_never_reaches_normal_start_or_next_direction(self):
        def refuse(value):
            if value['phase']=='migrated': value['status']='unknown'
            return value
        with self.assertRaisesRegex(a.control.ControlError, 'UNCONFIRMED'):
            with self.hold() as tx: a._run(tx, IMAGE, self.executor(refuse))
        self.assertEqual(len(self.calls), 3)
        journal = json.loads((self.root/'transaction-to-server.json').read_text())
        self.assertEqual(journal['phases'], ['prepared', 'writers_stopped'])
        self.assertEqual(journal['status'], 'incomplete')
        with self.assertRaisesRegex(a.control.ControlError, 'UNRESOLVED'):
            with self.hold('to-legacy'): pass

    def test_each_identity_or_missing_real_proof_rejected(self):
        mutations = [lambda x: x.update(actorPid=True), lambda x: x.update(actorStartTicks=1),
                     lambda x: x.update(image=IMAGE+'0'), lambda x: x.update(direction='to-legacy'),
                     lambda x: x['proofs'].pop('host_parents'),
                     lambda x: x['proofs'].update(host_parents=True)]
        with self.hold() as tx:
            for mutate in mutations:
                ex = self.executor()
                value = ex.prepare(direction='to-server', image=IMAGE, actor_pid=tx.value['actorPid'],
                                   actor_start_ticks=tx.value['actorStartTicks'])
                mutate(value)
                with self.assertRaisesRegex(a.control.ControlError, 'UNCONFIRMED'):
                    a._receipt(tx, 'prepared', IMAGE, value, a.PROOFS[0])
        self.assertEqual(list(self.root.glob('*.receipt.json')), [])

    def test_receipt_write_failure_leaves_incomplete_and_no_start(self):
        original = a.os.fsync
        def fail_file(fd):
            if Path(f'/proc/self/fd/{fd}').resolve().name.endswith('.receipt.json'):
                raise OSError('synthetic')
            original(fd)
        with self.hold() as tx, patch.object(a.os, 'fsync', fail_file):
            with self.assertRaises(OSError): a._run(tx, IMAGE, self.executor())
        journal = json.loads((self.root/'transaction-to-server.json').read_text())
        self.assertEqual(journal['phases'], [])
        self.assertEqual(len(self.calls), 1)

    def test_changed_receipt_cannot_confirm_phase(self):
        with self.hold() as tx, patch.object(a.control, '_saved', return_value={}):
            with self.assertRaisesRegex(a.control.ControlError, 'RECEIPT_CHANGED'):
                a._run(tx, IMAGE, self.executor())
        self.assertEqual(json.loads((self.root/'transaction-to-server.json').read_text())['phases'], [])
        self.assertEqual(len(self.calls), 1)

    def test_bad_image_stops_before_phase_executor(self):
        with self.hold() as tx:
            with self.assertRaisesRegex(a.control.ControlError, 'IMAGE'):
                a._run(tx, 'latest', self.executor())
        self.assertEqual(self.calls, [])


if __name__ == '__main__': unittest.main(verbosity=2)
