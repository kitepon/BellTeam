"""Synthetic-only tests: never open a production header or endpoint."""

import errno
import fcntl
import importlib.util
import io
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch


sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    'sce_installer', Path(__file__).resolve().parents[1] / 'scripts/install-sce-headers.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
FIRST = b'x-bughub-security-token: synthetic-generation-one\n'
SECOND = b'x-bughub-security-token: synthetic-generation-two\n'


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='sce-synthetic-')
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name) / 'state/bughub'
        self.folder.mkdir(parents=True, mode=0o711)
        self.header = self.folder / 'headers'
        self.header.write_bytes(FIRST)
        self.header.chmod(0o600)
        self.endpoint = self.folder / 'endpoint'
        self.endpoint.write_text('http://synthetic.invalid/api/security/v1\n')
        self.endpoint.chmod(0o600)

    def install(self, value=SECOND):
        installer.install(io.BytesIO(value), str(self.folder), server_uid=os.getuid(),
                          server_gid=os.getgid(), directory_uid=os.getuid())

    def preserved(self):
        self.assertEqual(self.header.read_bytes(), FIRST)
        self.assertEqual(list(self.folder.glob('.headers-*.tmp')), [])
        self.assertEqual(self.endpoint.read_text(), 'http://synthetic.invalid/api/security/v1\n')

    def test_atomic_update_changes_inode_and_preserves_endpoint(self):
        old_inode = self.header.stat().st_ino
        # An already opened fd retains its generation; a new open sees the new one.
        with self.header.open('rb') as old:
            self.install()
            self.assertEqual(old.read(), FIRST)
        self.assertEqual(self.header.read_bytes(), SECOND)
        self.assertNotEqual(self.header.stat().st_ino, old_inode)
        self.assertEqual(stat.S_IMODE(self.header.stat().st_mode), 0o600)
        self.assertEqual(self.endpoint.read_text(), 'http://synthetic.invalid/api/security/v1\n')

    def test_invalid_input_never_changes_current(self):
        values = [b'', b'\n', SECOND[:-1], b'x-bughub-actor: bot-impostor\n',
                  SECOND + b'x-bughub-actor: bot-impostor\n',
                  SECOND + b'\n', b'x-bughub-security-token: \n',
                  b'x-bughub-security-token: invalid token\n',
                  b'x-bughub-security-token: \x00\n', b'x' * (installer.MAX_INPUT + 1)]
        for value in values:
            with self.subTest(value_kind=len(value)):
                with self.assertRaises(installer.InstallError):
                    self.install(value)
                self.preserved()

    def test_interrupted_input_retains_current(self):
        class Interrupted:
            def read(self, _):
                raise InterruptedError(errno.EINTR, 'synthetic interruption')
        with self.assertRaises(InterruptedError):
            installer.install(Interrupted(), str(self.folder))
        self.preserved()

    def test_keyboard_interruption_before_commit_cleans_temp_and_retains_current(self):
        with patch.object(installer.os, 'write', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.install()
        self.preserved()

    def test_short_writes_are_completed(self):
        original = os.write
        with patch.object(installer.os, 'write', side_effect=lambda fd, data: original(fd, data[:3])):
            self.install()
        self.assertEqual(self.header.read_bytes(), SECOND)

    def test_write_chown_fsync_and_rename_failure_retain_current(self):
        for operation in ['write', 'fchown', 'fsync', 'replace']:
            with self.subTest(operation=operation):
                with patch.object(installer.os, operation, side_effect=OSError(errno.EIO, 'synthetic')):
                    with self.assertRaises(OSError):
                        self.install()
                self.preserved()

    def test_zero_write_retains_current(self):
        with patch.object(installer.os, 'write', return_value=0):
            with self.assertRaises(installer.InstallError):
                self.install()
        self.preserved()

    def test_temp_creation_failure_retains_current(self):
        real_open = os.open
        def failed_open(path, flags, *args, **kwargs):
            if isinstance(path, str) and path.startswith('.headers-'):
                raise PermissionError(errno.EACCES, 'synthetic')
            return real_open(path, flags, *args, **kwargs)
        with patch.object(installer.os, 'open', side_effect=failed_open):
            with self.assertRaises(PermissionError):
                self.install()
        self.preserved()

    def test_existing_symlink_is_rejected_without_touching_target(self):
        self.header.unlink()
        self.header.symlink_to(self.endpoint)
        with self.assertRaises(installer.InstallError):
            self.install()
        self.assertTrue(self.header.is_symlink())
        self.assertEqual(self.endpoint.read_text(), 'http://synthetic.invalid/api/security/v1\n')

    def test_temp_name_collision_does_not_remove_another_file(self):
        collision = self.folder / '.headers-collision.tmp'
        collision.write_bytes(b'other synthetic update')
        with patch.object(installer.secrets, 'token_hex', return_value='collision'):
            with self.assertRaises(FileExistsError):
                self.install()
        self.assertEqual(collision.read_bytes(), b'other synthetic update')
        collision.unlink()
        self.preserved()

    def test_symlink_in_parent_path_is_rejected(self):
        alias = Path(self.temporary.name) / 'alias'
        alias.symlink_to(self.folder, target_is_directory=True)
        with self.assertRaises(OSError):
            installer.install(io.BytesIO(SECOND), str(alias), server_uid=os.getuid(),
                              server_gid=os.getgid(), directory_uid=os.getuid())
        self.preserved()

    def test_non_searchable_or_readable_parent_and_non_private_current_are_rejected(self):
        for mode in [0o700, 0o755, 0o777]:
            self.folder.chmod(mode)
            with self.assertRaises(installer.InstallError):
                self.install()
            self.preserved()
        self.folder.chmod(0o711)
        self.header.chmod(0o644)
        with self.assertRaises(installer.InstallError):
            self.install()
        self.preserved()

    def test_wrong_parent_group_is_rejected_before_creating_a_candidate(self):
        wrong_group = SimpleNamespace(st_uid=os.getuid(), st_gid=os.getgid() + 1,
                                      st_mode=self.folder.stat().st_mode)
        with patch.object(installer.os, 'fstat', return_value=wrong_group):
            with self.assertRaisesRegex(installer.InstallError, 'SCE_INSTALL_DIRECTORY_INVALID'):
                self.install()
        self.preserved()

    def test_main_rejects_invalid_control_metadata_before_reading_stdin(self):
        class UnreadInput:
            def read(self, _):
                raise AssertionError('stdin read before control validation')
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(installer, 'DIRECTORY', str(self.folder)), \
                patch.object(installer.os, 'geteuid', return_value=0), \
                patch.object(installer.sys, 'argv', ['install-sce-headers']), \
                patch.object(installer.sys, 'stdin', SimpleNamespace(buffer=UnreadInput())), \
                redirect_stdout(output), redirect_stderr(errors):
            result = installer.main()
        self.assertEqual(result, 1)
        self.assertEqual(output.getvalue(), '')
        self.assertEqual(errors.getvalue(), 'SCE_INSTALL_DIRECTORY_INVALID\n')
        self.preserved()

    def test_main_rejects_replaced_control_inode_before_reading_stdin(self):
        info = Path(self.temporary.name).stat()
        held = SimpleNamespace(st_uid=0, st_gid=1001, st_mode=stat.S_IFDIR | 0o750,
                               st_dev=info.st_dev, st_ino=info.st_ino)
        linked = SimpleNamespace(**{**vars(held), 'st_ino': info.st_ino + 1})
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(installer, 'DIRECTORY', str(self.folder)), \
                patch.object(installer.os, 'geteuid', return_value=0), \
                patch.object(installer.os, 'fstat', return_value=held), \
                patch.object(installer.os, 'stat', return_value=linked), \
                patch.object(installer.sys, 'argv', ['install-sce-headers']), \
                patch.object(installer.sys, 'stdin', SimpleNamespace(buffer=object())), \
                redirect_stdout(output), redirect_stderr(errors):
            result = installer.main()
        self.assertEqual(result, 1)
        self.assertEqual(output.getvalue(), '')
        self.assertEqual(errors.getvalue(), 'SCE_INSTALL_DIRECTORY_INVALID\n')
        self.preserved()

    @unittest.skipUnless(os.geteuid() == 0, 'root-only synthetic control lock')
    def test_root_main_holds_shared_control_lock_and_refuses_maintenance_before_stdin(self):
        control = Path(self.temporary.name)
        os.chown(control, 0, 1001)
        control.chmod(0o750)
        for path in [self.folder, self.header, self.endpoint]:
            os.chown(path, 1001, 1001)
        descriptor = os.open(control, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, descriptor)
        class UnreadInput:
            def read(self, _):
                raise AssertionError('stdin read while maintenance holds EX')
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(installer, 'DIRECTORY', str(self.folder)), \
                patch.object(installer.sys, 'argv', ['install-sce-headers']), \
                redirect_stdout(output), redirect_stderr(errors):
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(installer.sys, 'stdin', SimpleNamespace(buffer=UnreadInput())):
                self.assertEqual(installer.main(), 75)
            self.assertEqual(output.getvalue(), '')
            self.assertEqual(errors.getvalue(), 'SCE_INSTALL_BUSY\n')
            self.preserved()
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            errors.seek(0); errors.truncate(0)
            checked = []
            class LockCheckingInput:
                def read(_self, _):
                    probe = os.open(control, os.O_RDONLY | os.O_DIRECTORY)
                    try:
                        with self.assertRaises(BlockingIOError):
                            fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        checked.append(True)
                    finally:
                        os.close(probe)
                    return SECOND
            with patch.object(installer.sys, 'stdin', SimpleNamespace(buffer=LockCheckingInput())):
                self.assertEqual(installer.main(), 0)
            self.assertEqual(checked, [True])
            # An unrelated normal SH is compatible with the CLI's writer SH.
            fcntl.flock(descriptor, fcntl.LOCK_SH | fcntl.LOCK_NB)
            with patch.object(installer.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(SECOND))):
                self.assertEqual(installer.main(), 0)
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        self.assertEqual(output.getvalue(), '')
        self.assertEqual(errors.getvalue(), '')
        self.assertEqual(self.header.read_bytes(), SECOND)
        info = self.header.stat()
        self.assertEqual((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)), (1001, 1001, 0o600))
        self.assertEqual(self.endpoint.read_text(), 'http://synthetic.invalid/api/security/v1\n')

    @unittest.skipUnless(os.geteuid() == 0, 'root-only synthetic UID separation')
    def test_root_owner_install_and_real_uid_read_boundaries(self):
        # Numeric identities only: no user creation or OS configuration changes.
        Path(self.temporary.name).chmod(0o711)
        os.chown(self.folder, 1001, 1001)
        os.chown(self.header, 1001, 1001)
        os.chown(self.endpoint, 1001, 1001)
        installer.install(io.BytesIO(SECOND), str(self.folder))
        for uid, expected in [(1000, 'denied'), (1001, 'allowed')]:
            read_fd, write_fd = os.pipe()
            pid = os.fork()
            if pid == 0:
                os.close(read_fd)
                try:
                    os.setgroups([])
                    os.setgid(uid)
                    os.setuid(uid)
                    # Both identities can distinguish a present file from absence.
                    try:
                        metadata = [path.stat() for path in [self.header, self.endpoint]]
                    except PermissionError:
                        outcome = 'stat_denied'
                    else:
                        if any((item.st_uid, item.st_gid, stat.S_IMODE(item.st_mode))
                               != (1001, 1001, 0o600) for item in metadata):
                            outcome = 'wrong_metadata'
                        else:
                            try:
                                with self.header.open('rb') as file:
                                    valid = file.read() == SECOND
                                outcome = 'allowed' if valid else 'wrong_generation'
                            except PermissionError:
                                outcome = 'denied'
                    os.write(write_fd, outcome.encode())
                finally:
                    os._exit(0)
            os.close(write_fd)
            actual = os.read(read_fd, 64).decode()
            os.close(read_fd)
            _, status = os.waitpid(pid, 0)
            self.assertEqual(status, 0)
            self.assertEqual(actual, expected)


if __name__ == '__main__':
    unittest.main(verbosity=2)
