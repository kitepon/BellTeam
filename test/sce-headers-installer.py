"""Synthetic-only tests: never open a production header or endpoint."""

import errno
import importlib.util
import io
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
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
        self.folder = Path(self.temporary.name) / 'bughub'
        self.folder.mkdir(mode=0o711)
        self.header = self.folder / 'headers'
        self.header.write_bytes(FIRST)
        self.header.chmod(0o600)
        self.endpoint = self.folder / 'endpoint'
        self.endpoint.write_text('http://synthetic.invalid/api/security/v1\n')

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

    def test_writable_parent_or_non_private_current_is_rejected(self):
        self.folder.chmod(0o777)
        with self.assertRaises(installer.InstallError):
            self.install()
        self.folder.chmod(0o711)
        self.header.chmod(0o644)
        with self.assertRaises(installer.InstallError):
            self.install()
        self.preserved()

    @unittest.skipUnless(os.geteuid() == 0, 'root-only synthetic UID separation')
    def test_root_owner_install_and_real_uid_read_boundaries(self):
        # Numeric identities only: no user creation or OS configuration changes.
        Path(self.temporary.name).chmod(0o711)
        os.chown(self.header, 1001, 1001)
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
