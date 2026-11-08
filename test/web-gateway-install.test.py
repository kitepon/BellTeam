import copy
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest
from unittest.mock import patch
import fcntl

sys.dont_write_bytecode = True

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/install-web-gateway-release.py'
spec = importlib.util.spec_from_file_location('gateway_install', SCRIPT)
writer = importlib.util.module_from_spec(spec); spec.loader.exec_module(writer)


class IsolatedWriterTest(unittest.TestCase):
    # Current-UID files and a verifier stub test placement only, never real root/crypto acceptance.
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.private = self.root / 'private'; self.private.mkdir(mode=0o750); self.private.chmod(0o750)
        self.incoming = self.root / 'incoming'; self.incoming.mkdir()
        self.state = self.private / 'state'; self.state.mkdir()
        self.adoption = self.state / 'web-gateway-release.json'; self.adoption.write_bytes(b'old adopted state\n')
        self.old = self.private / 'web-gateway/releases' / ('e' * 64)
        self.old.mkdir(parents=True); (self.old / 'old').write_bytes(b'keep old release')
        self.old.chmod(0o555)
        self.addCleanup(lambda: self.old.chmod(0o755))
        self.uid = patch.object(writer, 'ROOT_UID', os.getuid()); self.uid.start(); self.addCleanup(self.uid.stop)
        self.gid = patch.object(writer, 'SERVER_GID', os.getgid()); self.gid.start(); self.addCleanup(self.gid.stop)
        self.expected, self.receipt = self.archive()
        self.verifier = patch.object(writer, 'verify', side_effect=self.verified_fixture)
        self.verify = self.verifier.start(); self.addCleanup(self.verifier.stop)
        self.addCleanup(self.make_writable)
        publish = writer.publish
        def current_uid_publish(source, target):
            # Simulate root DAC_OVERRIDE only inside this current-UID fixture; NOREPLACE stays real.
            source.chmod(0o755)
            try: publish(source, target)
            finally: (source if source.exists() else target).chmod(0o555)
        self.publisher = patch.object(writer, 'publish', side_effect=current_uid_publish)
        self.publisher.start(); self.addCleanup(self.publisher.stop)

    def make_writable(self):
        for root, _, _ in os.walk(self.private): os.chmod(root, 0o700)

    def archive(self, extra=None, changed=False):
        files = {'payload/src/http-gateway-entry.mjs': b'export {}\n', 'payload/package.json': b'{}\n',
                 'payload/package-lock.json': b'{}\n', 'payload/web/assets.mjs': b'export {}\n'}
        manifest = dict(schema='bellteam.web-gateway.artifact.v1', component='web-gateway', sourceCommit='a' * 40,
                        entry='payload/src/http-gateway-entry.mjs', runtime=dict(os='linux', arch='amd64', nodeMajor=26, parentProtocol=1),
                        files=[dict(path=k, bytes=len(v), sha256=hashlib.sha256(v).hexdigest()) for k, v in files.items()])
        metadata = (json.dumps(manifest) + '\n').encode()
        out = io.BytesIO()
        with tarfile.open(fileobj=out, mode='w:gz') as archive:
            for name, content in [('manifest.json', metadata), *files.items()]:
                if changed and name.endswith('entry.mjs'): content = b'changed bytes'
                info = tarfile.TarInfo(name); info.size = len(content); archive.addfile(info, io.BytesIO(content))
            if extra:
                info = tarfile.TarInfo(extra[0]); info.size = 1
                if len(extra) > 1: info.type = tarfile.SYMTYPE; info.linkname = '../../outside'; info.size = 0
                archive.addfile(info, io.BytesIO(b'x'))
        raw = out.getvalue(); digest = hashlib.sha256(raw).hexdigest()
        path = self.incoming / digest; path.mkdir(exist_ok=True)
        (path / 'archive.tar.gz').write_bytes(raw); (path / 'bundle.json').write_bytes(b'unsigned fixture, never authenticated')
        expected = writer.expectation(digest, 'a' * 40, 'b' * 40)
        receipt = dict(schema='bellteam.web-gateway.verification.v1', archiveSha256=digest,
                       manifestSha256=hashlib.sha256(metadata).hexdigest(), manifest=manifest,
                       verification=dict(method='github-oidc-attestation', repositoryId='1404510084'))
        return expected, receipt

    def verified_fixture(self, archive, bundle, expectation):
        self.assertNotEqual(archive.stat().st_ino, (self.incoming / self.expected['archiveSha256'] / 'archive.tar.gz').stat().st_ino)
        self.assertEqual(stat.S_IMODE(archive.stat().st_mode), 0o400)
        self.assertEqual(json.loads(expectation.read_bytes()), self.expected)
        self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(), self.expected['archiveSha256'])
        return copy.deepcopy(self.receipt)

    def preserved(self):
        self.assertEqual(self.adoption.read_bytes(), b'old adopted state\n')
        self.assertEqual((self.old / 'old').read_bytes(), b'keep old release')
        self.assertEqual(list((self.private / 'web-gateway').glob('.staging-*')), [])

    def assert_install_waits(self, path, mode, install):
        held = os.open(path, os.O_RDONLY)
        fcntl.flock(held, fcntl.LOCK_EX)
        identity = os.fstat(held)
        waiting = threading.Event()
        flock = fcntl.flock
        def observe(fd, operation):
            info = os.fstat(fd if isinstance(fd, int) else fd.fileno())
            if (info.st_dev, info.st_ino) == (identity.st_dev, identity.st_ino):
                waiting.set()
                self.assertEqual(operation, mode)
            return flock(fd, operation)
        with ThreadPoolExecutor(max_workers=1) as pool:
            with patch.object(writer.fcntl, 'flock', side_effect=observe):
                result = pool.submit(install)
                try:
                    self.assertTrue(waiting.wait(5), 'installer must reach the held lock')
                    self.assertFalse(result.done(), 'installer must wait rather than fail')
                    self.verify.assert_not_called()
                    self.preserved()
                finally:
                    os.close(held)
                self.assertEqual(result.result(timeout=5), dict(versionId=self.expected['archiveSha256'], installed=True))
        self.preserved()

    def test_publish_immutable_and_installation_last_without_adopting_or_overwriting(self):
        events = []
        write = writer.write_file
        with patch.object(writer, 'write_file', side_effect=lambda p, d, mode=0o444: (events.append(p.name), write(p, d, mode))[1]):
            result = writer.install(self.private, self.incoming, self.expected)
        self.assertEqual(result, dict(versionId=self.expected['archiveSha256'], installed=True))
        self.assertEqual(events[-1], 'installation.json')
        target = self.private / 'web-gateway/releases' / self.expected['archiveSha256']
        for path in [target, *target.rglob('*')]:
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o555 if path.is_dir() else 0o444)
        with self.assertRaisesRegex(ValueError, 'GATEWAY_RELEASE_EXISTS'): writer.install(self.private, self.incoming, self.expected)
        self.assertEqual(self.verify.call_count, 1)
        self.preserved()

    def test_verification_failure_cleans_only_this_staging(self):
        self.verify.side_effect = ValueError('GATEWAY_INSTALL_VERIFICATION_FAILED')
        with self.assertRaisesRegex(ValueError, 'VERIFICATION_FAILED'): writer.install(self.private, self.incoming, self.expected)
        self.assertEqual(list((self.private / 'web-gateway/releases').iterdir()), [self.old])
        self.preserved()

    def test_link_traversal_duplicate_and_extra_member_rejected_after_stubbed_verifier(self):
        for extra in [('payload/../../outside',), ('payload/link', True), ('payload/src/http-gateway-entry.mjs',), ('payload/extra',)]:
            with self.subTest(extra=extra):
                self.expected, self.receipt = self.archive(extra=extra)
                with self.assertRaisesRegex(ValueError, 'GATEWAY_INSTALL_MEMBER'): writer.install(self.private, self.incoming, self.expected)
                self.preserved()
        self.assertFalse((self.root / 'outside').exists())

    def test_bytes_change_rejected_and_readonly_stage_is_cleaned(self):
        self.expected, self.receipt = self.archive(changed=True)
        with self.assertRaisesRegex(ValueError, 'GATEWAY_INSTALL_CONTENT_CHANGED'): writer.install(self.private, self.incoming, self.expected)
        self.preserved()

    def test_private_shared_lock_coexists_with_server_and_excludes_maintenance(self):
        parent = os.open(self.private, os.O_RDONLY | os.O_DIRECTORY)
        try:
            fcntl.flock(parent, fcntl.LOCK_SH | fcntl.LOCK_NB)
            original = self.verify.side_effect
            def observe(*args):
                other = os.open(self.private, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    with self.assertRaises(BlockingIOError): fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally: os.close(other)
                return original(*args)
            self.verify.side_effect = observe
            writer.install(self.private, self.incoming, self.expected)
        finally: os.close(parent)
        self.preserved()

    def test_component_install_queues_until_previous_writer_releases_lock(self):
        lock = self.private / 'web-gateway/.install.lock'; lock.touch(mode=0o600)
        self.assert_install_waits(lock, fcntl.LOCK_EX, lambda: writer.install(self.private, self.incoming, self.expected))

    def test_whole_maintenance_exclusive_lock_queues_install(self):
        self.assert_install_waits(self.private, fcntl.LOCK_SH, lambda: writer.install(self.private, self.incoming, self.expected))

    def test_transaction_marker_does_not_block_install_or_change_marker(self):
        marker = self.private / '.transaction.json'; marker.write_bytes(b'pending')
        writer.install(self.private, self.incoming, self.expected)
        self.assertEqual(marker.read_bytes(), b'pending')
        self.preserved()

    def test_input_symlink_refused(self):
        path = self.incoming / self.expected['archiveSha256'] / 'bundle.json'; path.unlink(); path.symlink_to('/etc/passwd')
        with self.assertRaises(OSError): writer.install(self.private, self.incoming, self.expected)
        self.verify.assert_not_called(); self.preserved()

    def test_interruption_cleans_stage_and_preserves_adoption(self):
        self.verify.side_effect = KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt): writer.install(self.private, self.incoming, self.expected)
        self.preserved()

    def test_crashed_stage_cleanup_and_post_publish_sync_failure_preserve_complete_candidate(self):
        stale = self.private / 'web-gateway/.staging-crash'; stale.mkdir(); (stale / 'partial').write_bytes(b'x')
        sync = writer.sync_directory
        def fail_sync(path):
            if Path(path).name == 'releases': raise OSError('synthetic sync failure')
            sync(path)
        with patch.object(writer, 'sync_directory', side_effect=fail_sync):
            with self.assertRaises(OSError): writer.install(self.private, self.incoming, self.expected)
        target = self.private / 'web-gateway/releases' / self.expected['archiveSha256']
        self.assertTrue((target / 'installation.json').is_file()); self.preserved()

    def test_fixed_cli_rejects_paths_and_nonroot_before_private_writes(self):
        result = subprocess.run([sys.executable, str(SCRIPT), '../x', 'a' * 40, 'b' * 40], capture_output=True)
        self.assertEqual(result.returncode, 1); self.assertEqual(result.stdout, b'')
        self.assertIn(b'GATEWAY_INSTALL_ARGUMENTS', result.stderr)
        if os.geteuid() != 0:
            result = subprocess.run([sys.executable, str(SCRIPT), 'a' * 64, 'a' * 40, 'b' * 40], capture_output=True)
            self.assertIn(b'GATEWAY_INSTALL_ROOT_REQUIRED', result.stderr)
        self.preserved()


if __name__ == '__main__': unittest.main()
