import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('prepare_actor',
    Path(__file__).resolve().parents[1]/'distribution/internal/sec014-host-actor.py')
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
IMAGE = 'ghcr.io/kitepon/bellteam-server@sha256:' + 'a'*64


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)/'control'
        self.root.mkdir(mode=0o700)
        self.state = Path(self.tmp.name)/'state-data'
        self.state.mkdir(mode=0o700)
        self.owner = os.getuid(), os.getgid()
        parent = self.state.stat()
        value = {'schema': 'bellteam.state-directories.v1',
                 'parent': {'device': str(parent.st_dev), 'inode': str(parent.st_ino)},
                 'leaves': []}
        for name in a.prepared.LEAVES:
            (self.state/name).mkdir(mode=0o711)
            st = (self.state/name).stat()
            value['leaves'].append({'name': name, 'device': str(st.st_dev), 'inode': str(st.st_ino)})
        (self.state/'.prepared.json').write_text(json.dumps(value))
        (self.state/'.prepared.json').chmod(0o600)

    def hold(self):
        return a.control._hold(self.root, 'to-server', self.owner)

    def terminal(self, tx):
        name = f"sec014-to-server-{tx.value['actorPid']}-{tx.value['actorStartTicks']}-prepare"
        return dict(schema='bellteam.sec014.prepare-terminal.v1', direction='to-server',
                    image=IMAGE, actorPid=tx.value['actorPid'], actorStartTicks=tx.value['actorStartTicks'],
                    clientPid=4321, clientStartTicks=8765, containerId='c'*64,
                    containerName=name, status='exited', exitCode=0, unknown=False,
                    argv=['/usr/bin/docker', 'compose', '--env-file', '/dev/null', '-f',
                          '/home/kite/BellTeam/compose.state-prepare.yaml', 'run', '--no-deps',
                          '--name', name, '-T', 'state-prepare'])

    def raw(self):
        with self.assertRaisesRegex(a.control.ControlError, 'BUSY'):
            with self.hold(): pass
        return a.prepared._read(self.state, self.owner, self.owner) + b'\n'

    def journal(self):
        return json.loads((self.root/'transaction-to-server.json').read_text())

    def test_exact_metadata_raw_and_terminal_saved_before_phase_confirmation(self):
        with self.hold() as tx, patch.object(a.prepared, 'read_prepared_proof', side_effect=self.raw):
            value = a.prepared_phase_receipt(tx, IMAGE, self.terminal(tx), 'b'*64)
            artifact_path = self.root/'to-server-prepare-evidence.json'
            artifact = json.loads(artifact_path.read_bytes())
            self.assertTrue(artifact['metadataUtf8'].endswith('\n'))
            self.assertEqual(artifact['metadataSha256'], hashlib.sha256(artifact['metadataUtf8'].encode()).hexdigest())
            self.assertEqual(value['proofs']['six_prepared_leaves'], hashlib.sha256(artifact_path.read_bytes()).hexdigest())
            self.assertEqual(artifact['terminal'], self.terminal(tx))
            self.assertEqual(artifact_path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(self.journal()['phases'], [])
            a._receipt(tx, 'prepared', IMAGE, value, a.PROOFS[0])
            tx.confirmed('prepared')
        self.assertEqual(self.journal()['phases'], ['prepared'])
        self.assertEqual(self.journal()['status'], 'incomplete')

    def test_unconfirmed_terminal_refuses_before_metadata_read(self):
        with self.hold() as tx, patch.object(a.prepared, 'read_prepared_proof') as read:
            for field, bad in [('exitCode', 1), ('exitCode', False), ('unknown', True),
                               ('clientPid', True), ('argv', []), ('status', 'running')]:
                terminal = self.terminal(tx); terminal[field] = bad
                with self.assertRaisesRegex(a.control.ControlError, 'TERMINAL_UNCONFIRMED'):
                    a.prepared_phase_receipt(tx, IMAGE, terminal, 'b'*64)
            read.assert_not_called()
        self.assertFalse((self.root/'to-server-prepare-evidence.json').exists())
        self.assertEqual(self.journal()['phases'], [])

    def test_changed_leaf_never_publishes_prepare_evidence(self):
        (self.state/'state').chmod(0o700)
        with self.hold() as tx, patch.object(a.prepared, 'read_prepared_proof', side_effect=self.raw):
            with self.assertRaises(RuntimeError):
                a.prepared_phase_receipt(tx, IMAGE, self.terminal(tx), 'b'*64)
        self.assertFalse((self.root/'to-server-prepare-evidence.json').exists())
        self.assertEqual(self.journal()['phases'], [])

    def test_evidence_fsync_failure_cannot_advance_journal(self):
        original = a.os.fsync
        def fail(fd):
            if Path(f'/proc/self/fd/{fd}').resolve().name.endswith('prepare-evidence.json'):
                raise OSError('synthetic evidence fsync')
            original(fd)
        with self.hold() as tx, patch.object(a.prepared, 'read_prepared_proof', side_effect=self.raw):
            with patch.object(a.os, 'fsync', side_effect=fail), self.assertRaises(OSError):
                a.prepared_phase_receipt(tx, IMAGE, self.terminal(tx), 'b'*64)
        self.assertEqual(self.journal()['phases'], [])
        self.assertFalse((self.root/'to-server-prepared.receipt.json').exists())

    def test_equal_json_different_inode_artifact_refused(self):
        original = a.control._saved
        def replace(parent, name, owner):
            value = original(parent, name, owner)
            if name.endswith('prepare-evidence.json'):
                path = self.root/name
                raw = path.read_bytes()
                path.rename(self.root/'retained')
                path.write_bytes(raw); path.chmod(0o600)
            return value
        with self.hold() as tx, patch.object(a.prepared, 'read_prepared_proof', side_effect=self.raw):
            with patch.object(a.control, '_saved', side_effect=replace):
                with self.assertRaisesRegex(a.control.ControlError, 'RECEIPT_CHANGED'):
                    a.prepared_phase_receipt(tx, IMAGE, self.terminal(tx), 'b'*64)
        self.assertEqual(self.journal()['phases'], [])

    def test_actor_prepared_artifact_then_writer_refusal_stops_flow(self):
        test = self
        with self.hold() as tx, patch.object(a.prepared, 'read_prepared_proof', side_effect=self.raw):
            class Executor:
                def prepare(self, **fields):
                    return a.prepared_phase_receipt(tx, IMAGE, test.terminal(tx), 'b'*64)
                def assert_writers_stopped(self, **fields):
                    raise RuntimeError('writer original not supplied')
                def backup_and_migrate(self, **fields): raise AssertionError('must not run')
                def assert_binds(self, **fields): raise AssertionError('must not run')
                def start_selected_normal(self, **fields): raise AssertionError('must not run')
                def verify_result(self, **fields): raise AssertionError('must not run')
            with self.assertRaisesRegex(RuntimeError, 'writer original'):
                a._run(tx, IMAGE, Executor())
        self.assertEqual(self.journal()['phases'], ['prepared'])
        self.assertEqual(self.journal()['status'], 'incomplete')


if __name__ == '__main__': unittest.main(verbosity=2)
