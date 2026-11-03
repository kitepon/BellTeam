import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class CleanupPrerequisites(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'scripts').mkdir()
        (self.root / 'bin').mkdir()
        source = Path(__file__).resolve().parents[1]
        for name in ['cleanup-deploy-images.py', 'save-deploy-restore-point.py']:
            shutil.copyfile(source / 'scripts' / name, self.root / 'scripts' / name)
        # This trap models NAS EACCES without touching any real NAS or Docker.
        save = self.root / 'scripts/save-deploy-restore-point.py'
        text = save.read_text().replace("if __name__ == '__main__':", """def mount_guard(path):
    raise PermissionError('fixture NAS inaccessible to cleanup UID')


if __name__ == '__main__':""")
        save.write_text(text)
        self.previous = 'sha256:' + 'a' * 64
        docker = self.root / 'bin/docker'
        docker.write_text('#!' + sys.executable + '\n' + """import json,sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
with (root/'docker-calls').open('a') as log: log.write(json.dumps(sys.argv[1:])+'\\n')
args=sys.argv[1:]
if args==['ps','-aq']: print('')
elif args[:2]==['image','ls']: print('sha256:'+'a'*64)
elif args[:2]==['image','inspect']:
    print(json.dumps([{'Id':'sha256:'+'a'*64,'RepoTags':['bellteam-server:previous'],'Created':'old'}]))
else: raise AssertionError(args)
""")
        docker.chmod(0o700)

    def run_helper(self, script='cleanup-deploy-images.py', args=(), cwd=None):
        return subprocess.run([sys.executable, '-B', str(self.root / 'scripts' / script), *args],
                              cwd=cwd or self.root, text=True, capture_output=True,
                              env={**os.environ, 'PATH': str(self.root / 'bin') + os.pathsep + os.environ['PATH']})

    def test_normal_previous_mode_never_reads_inaccessible_nas(self):
        result = self.run_helper(args=['--rollback-image', self.previous])
        self.assertEqual(result.returncode, 0, result.stderr)
        rows = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(rows[0]['rollbackSource'], 'caller-previous-runtime')
        self.assertEqual(rows[0]['protectedImages'], [self.previous])
        self.assertEqual(rows[0]['targetImages'], [])
        self.assertEqual(rows[-1]['removed'], [])
        self.assertEqual(result.stderr, '')

    def test_all_modes_share_root_inode_across_generations_and_release_on_close(self):
        fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            for generation, script, args in [
                ('one', 'cleanup-deploy-images.py', ['--rollback-image', self.previous]),
                ('two', 'cleanup-deploy-images.py', []),
                ('three', 'save-deploy-restore-point.py', []),
            ]:
                cwd = self.root / generation
                cwd.mkdir()
                with self.subTest(script=script, args=args):
                    result = self.run_helper(script, args, cwd)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('BlockingIOError', result.stderr)
                    self.assertNotIn('fixture NAS', result.stderr)
                    self.assertEqual(result.stdout, '')
            self.assertFalse((self.root / 'docker-calls').exists())
        finally:
            os.close(fd)
        self.assertEqual(self.run_helper(args=['--rollback-image', self.previous]).returncode, 0)

    def test_legacy_and_save_still_require_nas_and_release_lock_on_error(self):
        for script in ['cleanup-deploy-images.py', 'save-deploy-restore-point.py']:
            with self.subTest(script=script):
                result = self.run_helper(script)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('fixture NAS inaccessible', result.stderr)
                self.assertEqual(result.stdout, '')
                fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally:
                    os.close(fd)
        self.assertFalse((self.root / 'docker-calls').exists())

    def test_legacy_and_save_keep_the_existing_nas_lock(self):
        save = self.root / 'scripts/save-deploy-restore-point.py'
        save.write_text(save.read_text().replace(
            "raise PermissionError('fixture NAS inaccessible to cleanup UID')", 'pass').replace(
            "if __name__ == '__main__':", "BASE = Path(__file__).resolve().parents[1] / 'nas'\n\nif __name__ == '__main__':"))
        base = self.root / 'nas'
        base.mkdir()
        with (base / '.lock').open('a+b') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            for script in ['cleanup-deploy-images.py', 'save-deploy-restore-point.py']:
                with self.subTest(script=script):
                    result = self.run_helper(script)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('BlockingIOError', result.stderr)
                    self.assertEqual(result.stdout, '')
        self.assertEqual({p.name for p in base.iterdir()}, {'.lock'})
        self.assertFalse((self.root / 'docker-calls').exists())

    def test_normal_inspect_failure_releases_common_lock_without_plan(self):
        result = self.run_helper(args=['--rollback-image', 'sha256:' + 'b' * 64])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('image inspect identity mismatch', result.stderr)
        self.assertEqual(result.stdout, '')
        self.assertEqual(self.run_helper(args=['--rollback-image', self.previous]).returncode, 0)


if __name__ == '__main__':
    unittest.main()
