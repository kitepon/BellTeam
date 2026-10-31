import io
import json
import os
import sqlite3
import subprocess
import tarfile
import tempfile
import time
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/archive-live-volume.py'


class LiveVolumeArchiveTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.volume = self.root / 'volume'
        self.volume.mkdir()
        self.addCleanup(self.tmp.cleanup)

    def archive(self):
        return subprocess.run(['python3', str(SCRIPT), 'create', str(self.volume)], capture_output=True, timeout=15)

    def restore(self, data, destination=None):
        source = self.root / 'cursor.tar'
        source.write_bytes(data)
        destination = destination or self.root / 'restored'
        result = subprocess.run(['python3', str(SCRIPT), 'restore', str(source), str(destination)], capture_output=True, timeout=15)
        return result, destination

    def database(self, name='history.db'):
        writer = sqlite3.connect(self.volume / name)
        self.addCleanup(writer.close)
        writer.execute('pragma journal_mode=wal')
        writer.execute('pragma wal_autocheckpoint=0')
        writer.execute('create table t (v text)')
        writer.execute("insert into t values ('in-wal')")
        writer.commit()
        return writer

    def test_complete_cli_and_multiple_sqlite_restore_without_raw_sidecars(self):
        (self.volume / 'cursor').write_text('cli')
        (self.volume / 'cursor').chmod(0o771)
        (self.volume / 'link').symlink_to('cursor')
        self.database()
        self.database('recall.db')
        result = self.archive()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        with tarfile.open(fileobj=io.BytesIO(result.stdout)) as archive:
            self.assertIn('raw/history.db-wal', archive.getnames())
            self.assertIn('raw/history.db-shm', archive.getnames())
            manifest = json.load(archive.extractfile('manifest.json'))
            self.assertEqual(set(manifest['databases']), {'history.db', 'recall.db'})
            self.assertEqual(manifest['identities']['history.db'][1], (self.volume / 'history.db').stat().st_ino)
        restored, output = self.restore(result.stdout)
        self.assertEqual(restored.returncode, 0, restored.stderr.decode())
        for name in ('history.db', 'recall.db'):
            self.assertFalse((output / (name + '-wal')).exists())
            self.assertFalse((output / (name + '-shm')).exists())
            with sqlite3.connect(output / name) as conn:
                self.assertEqual(conn.execute('select v from t').fetchall(), [('in-wal',)])
        self.assertEqual((output / 'link').readlink(), Path('cursor'))
        self.assertEqual((output / 'cursor').read_text(), 'cli')
        self.assertEqual((output / 'cursor').stat().st_mode & 0o777, 0o771)
        again, _ = self.restore(result.stdout, output)
        self.assertNotEqual(again.returncode, 0)
        self.assertEqual((output / 'cursor').read_text(), 'cli')

    def test_missing_root_bad_db_and_sqlite_hardlink_fail(self):
        missing = subprocess.run(['python3', str(SCRIPT), 'create', str(self.root / 'missing')], capture_output=True)
        self.assertNotEqual(missing.returncode, 0)
        db = self.volume / 'corrupt.db'
        db.write_bytes(b'SQLite format 3\x00' + bytes(4096))
        self.assertNotEqual(self.archive().returncode, 0)
        db.unlink()
        self.database()
        os.link(self.volume / 'history.db', self.volume / 'alias.db')
        self.assertNotEqual(self.archive().returncode, 0)

    def test_changed_regular_file_fails_closed(self):
        path = self.volume / 'large'
        with path.open('wb') as stream:
            stream.truncate(8 * 1024 * 1024)
        proc = subprocess.Popen(['python3', str(SCRIPT), 'create', str(self.volume)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        time.sleep(.25)
        with path.open('r+b') as stream:
            stream.write(b'changed')
        _, error = proc.communicate(timeout=15)
        self.assertNotEqual(proc.returncode, 0, error.decode())
        self.assertIn(b'changed during archive', error)

    def hook(self, code, timeout=15):
        program = '''
import os,pathlib,runpy,sqlite3,sys,tarfile
script, root = sys.argv[1:]
root = pathlib.Path(root)
''' + code + '''
sys.argv = [script, 'create', str(root)]
runpy.run_path(script, run_name='__main__')
'''
        return subprocess.run(['python3', '-c', program, str(SCRIPT), str(self.volume)], capture_output=True, timeout=timeout)

    def test_late_growth_new_entry_and_unrelated_suffix_refuse(self):
        for name in ('file', 'notes-wal'):
            with self.subTest(name=name):
                path = self.volume / name
                path.write_bytes(b'ABC')
                result = self.hook('''
original = tarfile.TarFile.gettarinfo
def changed(self, name=None, arcname=None, fileobj=None):
    info = original(self, name, arcname, fileobj)
    if pathlib.Path(name).name in ('file', 'notes-wal'):
        with open(name, 'ab') as stream: stream.write(b'DEF')
    return info
tarfile.TarFile.gettarinfo = changed
''')
                self.assertNotEqual(result.returncode, 0, result.stderr.decode())
                path.unlink()
        result = self.hook('''
original = tarfile.TarFile.gettarinfo
def changed(self, name=None, arcname=None, fileobj=None):
    info = original(self, name, arcname, fileobj)
    if pathlib.Path(name) == root: (root / 'new').write_bytes(b'new')
    return info
tarfile.TarFile.gettarinfo = changed
''')
        self.assertNotEqual(result.returncode, 0)

    def test_classification_and_raw_fifo_swap_do_not_block(self):
        for phase in ('classification', 'raw'):
            with self.subTest(phase=phase):
                path = self.volume / 'file'
                path.write_bytes(b'ABC')
                result = self.hook('''
original = os.open
calls = 0
def swapped(path, flags, *args, **kwargs):
    global calls
    if pathlib.Path(path) == root / 'file':
        calls += 1
        if calls == COUNT:
            pathlib.Path(path).unlink()
            os.mkfifo(path)
    return original(path, flags, *args, **kwargs)
os.open = swapped
'''.replace('COUNT', '1' if phase == 'classification' else '2'), timeout=3)
                self.assertNotEqual(result.returncode, 0)
                path.unlink()

    def test_wal_truncate_retains_bounded_observation_and_restores_snapshot(self):
        self.database()
        result = self.hook('''
original = tarfile.TarFile.gettarinfo
def truncate(self, name=None, arcname=None, fileobj=None):
    info = original(self, name, arcname, fileobj)
    if pathlib.Path(name) == root / 'history.db-wal':
        conn=sqlite3.connect(root / 'history.db')
        conn.execute('pragma wal_checkpoint(truncate)')
        conn.close()
    return info
tarfile.TarFile.gettarinfo = truncate
''')
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        restored, output = self.restore(result.stdout)
        self.assertEqual(restored.returncode, 0, restored.stderr.decode())
        with sqlite3.connect(output / 'history.db') as conn:
            self.assertEqual(conn.execute('select v from t').fetchall(), [('in-wal',)])

    def test_continuous_writer_restores_commits(self):
        self.database()
        code = '''
import pathlib,sqlite3,sys,time
root=pathlib.Path(sys.argv[1]); c=sqlite3.connect(root/'history.db'); c.execute('pragma wal_autocheckpoint=0')
end=time.monotonic()+12; count=0
(root/'ready').write_text('ready')
while time.monotonic()<end:
 c.execute('insert into t values (?)',(str(count),)); c.commit(); count+=1
 if count%10==0: c.execute('pragma wal_checkpoint(passive)')
 time.sleep(.001)
'''
        # The marker stays outside the volume namespace being archived.
        writer = subprocess.Popen(['python3', '-c', code.replace("(root/'ready')", "(root.parent/'ready')"), str(self.volume)])
        self.addCleanup(lambda: writer.poll() is None and writer.terminate())
        deadline=time.monotonic()+3
        while not (self.root / 'ready').exists() and time.monotonic()<deadline:
            time.sleep(.01)
        self.assertTrue((self.root / 'ready').exists())
        result = self.archive()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertIsNone(writer.poll(), 'archive completes while writer remains active')
        restored, output = self.restore(result.stdout)
        self.assertEqual(restored.returncode, 0, restored.stderr.decode())
        with sqlite3.connect(output / 'history.db') as conn:
            self.assertGreater(conn.execute('select count(*) from t').fetchone()[0], 1)
        writer.terminate(); writer.wait(timeout=3)

    def test_database_replacement_and_backup_error_refuse(self):
        self.database()
        result = self.hook('''
original=tarfile.TarFile.addfile
def replaced(self, tarinfo, fileobj=None):
    result=original(self, tarinfo, fileobj)
    if tarinfo.name == 'raw/history.db':
        (root/'history.db').rename(root/'replaced.db')
        (root/'history.db').write_bytes(b'SQLite format 3\\x00'+bytes(4096))
    return result
tarfile.TarFile.addfile=replaced
''')
        self.assertNotEqual(result.returncode, 0)

    def test_old_raw_wal_never_overlays_newer_snapshot(self):
        self.database()
        result = self.hook('''
original=tarfile.TarFile.addfile
def append(self, tarinfo, fileobj=None):
    result=original(self,tarinfo,fileobj)
    if tarinfo.name == 'raw/history.db-wal':
        conn=sqlite3.connect(root/'history.db')
        conn.execute("insert into t values ('newer-snapshot')")
        conn.commit(); conn.close()
    return result
tarfile.TarFile.addfile=append
''')
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        restored, output = self.restore(result.stdout)
        self.assertEqual(restored.returncode, 0, restored.stderr.decode())
        self.assertFalse((output / 'history.db-wal').exists())
        with sqlite3.connect(output / 'history.db') as conn:
            self.assertEqual(conn.execute('select v from t').fetchall(), [('in-wal',), ('newer-snapshot',)])

    def test_truncate_during_spool_records_actual_bounded_bytes(self):
        self.database()
        result = self.hook('''
import tempfile
original=tempfile.TemporaryFile
calls=0
def spool(*args,**kwargs):
    global calls
    calls+=1
    if calls == 3:
        conn=sqlite3.connect(root/'history.db')
        conn.execute('pragma wal_checkpoint(truncate)'); conn.close()
    return original(*args,**kwargs)
tempfile.TemporaryFile=spool
''')
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        with tarfile.open(fileobj=io.BytesIO(result.stdout)) as archive:
            observation=json.load(archive.extractfile('manifest.json'))['observations']['history.db-wal']
            self.assertGreater(observation['limit'], observation['bytes'])
            self.assertEqual(archive.getmember('raw/history.db-wal').size, observation['bytes'])
        restored, output=self.restore(result.stdout)
        self.assertEqual(restored.returncode, 0, restored.stderr.decode())
        with sqlite3.connect(output/'history.db') as conn:
            self.assertEqual(conn.execute('select count(*) from t').fetchone()[0], 1)

    def test_snapshot_failure_and_deadline_cannot_restore_partial_archive(self):
        self.database()
        for condition in ('failed', 'deadline'):
            with self.subTest(condition=condition):
                code='''
import time
original=sqlite3.connect
class Broken(sqlite3.Connection):
    def backup(self, target, **kwargs):
        if CONDITION == 'failed': raise sqlite3.OperationalError('synthetic backup failure')
        previous=time.monotonic()
        time.monotonic=lambda: previous+121
        kwargs['progress'](0,1,1)
def connect(*args,**kwargs):
    if isinstance(args[0],str) and '?mode=ro' in args[0]: kwargs['factory']=Broken
    return original(*args,**kwargs)
sqlite3.connect=connect
'''.replace('CONDITION', repr(condition))
                result=self.hook(code)
                self.assertNotEqual(result.returncode,0)
                restored, output=self.restore(result.stdout)
                self.assertNotEqual(restored.returncode,0)
                self.assertFalse(output.exists())

    def test_uncommitted_transaction_is_not_in_snapshot(self):
        writer=self.database()
        writer.execute('begin immediate')
        writer.execute("insert into t values ('uncommitted')")
        result=self.archive()
        self.assertEqual(result.returncode,0,result.stderr.decode())
        restored,output=self.restore(result.stdout)
        self.assertEqual(restored.returncode,0,restored.stderr.decode())
        with sqlite3.connect(output/'history.db') as conn:
            self.assertEqual(conn.execute('select v from t').fetchall(),[('in-wal',)])
        writer.rollback()

    def test_restore_rejects_missing_snapshot_and_parent_symlink(self):
        self.database()
        result=self.archive()
        self.assertEqual(result.returncode,0,result.stderr.decode())
        buffer=io.BytesIO()
        with tarfile.open(fileobj=io.BytesIO(result.stdout)) as source, tarfile.open(fileobj=buffer,mode='w') as target:
            for member in source:
                if member.name != 'sqlite/history.db':
                    target.addfile(member,source.extractfile(member) if member.isfile() else None)
        restored,output=self.restore(buffer.getvalue())
        self.assertNotEqual(restored.returncode,0)
        self.assertFalse(output.exists())
        outside=self.root/'outside'; outside.mkdir()
        (self.volume/'escape').symlink_to(outside,target_is_directory=True)
        result=self.archive()
        self.assertEqual(result.returncode,0,result.stderr.decode())
        restored,output=self.restore(result.stdout)
        self.assertNotEqual(restored.returncode,0)
        self.assertFalse(output.exists())
        self.assertEqual(list(outside.iterdir()),[])


if __name__ == '__main__':
    unittest.main()
