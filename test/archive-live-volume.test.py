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

    def test_final_replacement_refusal_identifies_the_relative_path(self):
        (self.volume / 'file').write_bytes(b'ABC')
        result = self.hook('''
original = os.walk
calls = 0
def replace(*args, **kwargs):
    global calls
    calls += 1
    if calls == 2:
        (root/'replacement').write_bytes(b'DEF')
        os.replace(root/'replacement', root/'file')
    return original(*args, **kwargs)
os.walk = replace
''')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'volume entry replaced during archive: file', result.stderr)
        restored, output = self.restore(result.stdout)
        self.assertNotEqual(restored.returncode, 0)
        self.assertFalse(output.exists())

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

    def test_restore_rejects_missing_snapshot_and_preserves_external_leaf_link(self):
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
        self.assertEqual(restored.returncode,0,restored.stderr.decode())
        self.assertEqual((output/'escape').readlink(),outside)
        self.assertEqual(list(outside.iterdir()),[])

    def test_relative_external_reference_is_preserved_without_external_writes(self):
        outside=self.root/'outside'; outside.mkdir()
        sentinel=outside/'sentinel'; sentinel.write_text('unchanged')
        (self.volume/'escape').symlink_to('../outside',target_is_directory=True)
        result=self.archive()
        self.assertEqual(result.returncode,0,result.stderr.decode())
        restored,output=self.restore(result.stdout)
        self.assertEqual(restored.returncode,0,restored.stderr.decode())
        self.assertEqual((output/'escape').readlink(),Path('../outside'))
        self.assertEqual(sentinel.read_text(),'unchanged')

    def test_absolute_links_hardlinks_and_readonly_directory_keep_metadata(self):
        (self.volume/'releases').mkdir(); (self.volume/'bin').mkdir()
        binary=self.volume/'releases/cli'; binary.write_bytes(b'cli'); binary.chmod(0o771)
        os.link(binary,self.volume/'hard-cli')
        links={'bin/agent':'/home/bell/.local/releases/cli','bin/python3':'/usr/bin/python3',
               'project':'../../srv/bellteam/bots/example','bin/local':'../releases/cli'}
        for name,target in links.items(): (self.volume/name).symlink_to(target)
        (self.volume/'bin').chmod(0o555)
        self.database()
        result=self.archive(); self.assertEqual(result.returncode,0,result.stderr.decode())
        restored,output=self.restore(result.stdout); self.assertEqual(restored.returncode,0,restored.stderr.decode())
        for name,target in links.items():self.assertEqual(str((output/name).readlink()),target)
        self.assertEqual((output/'releases/cli').stat().st_ino,(output/'hard-cli').stat().st_ino)
        self.assertEqual((output/'releases/cli').stat().st_mode&0o777,0o771)
        self.assertEqual((output/'bin').stat().st_mode&0o777,0o555)

    def test_symlink_ancestor_and_external_hardlink_placements_are_rejected(self):
        (self.volume/'safe').write_bytes(b'safe')
        outside=self.root/'outside';outside.mkdir();sentinel=outside/'sentinel';sentinel.write_bytes(b'unchanged')
        (self.volume/'escape').symlink_to(outside,target_is_directory=True)
        result=self.archive();self.assertEqual(result.returncode,0,result.stderr.decode())
        for kind in ('file','link','hard-child','hard-outside','hard-link-target'):
            with self.subTest(kind=kind):
                buffer=io.BytesIO()
                with tarfile.open(fileobj=io.BytesIO(result.stdout)) as source,tarfile.open(fileobj=buffer,mode='w') as target:
                    for member in source:target.addfile(member,source.extractfile(member) if member.isfile() else None)
                    member=tarfile.TarInfo('raw/escape/sentinel' if kind=='file' else 'raw/escape/child' if kind in ('link','hard-child') else 'raw/hard')
                    if kind=='file':member.size=7;target.addfile(member,io.BytesIO(b'changed'))
                    else:
                        member.type=tarfile.SYMTYPE if kind=='link' else tarfile.LNKTYPE
                        member.linkname='raw/safe' if kind=='hard-child' else str(sentinel) if kind=='hard-outside' else 'raw/escape'
                        target.addfile(member)
                restored,output=self.restore(buffer.getvalue())
                self.assertNotEqual(restored.returncode,0)
                self.assertFalse(output.exists())
                self.assertEqual(sentinel.read_bytes(),b'unchanged')

    def test_read_only_backup_of_closed_wal_database_can_create_sidecars(self):
        db=self.volume/'closed.db'
        with sqlite3.connect(db) as conn:
            conn.execute('pragma journal_mode=wal')
            conn.execute('create table t(v)')
            conn.execute('insert into t values (1)')
        conn.close()
        self.assertEqual(sorted(p.name for p in self.volume.iterdir()),['closed.db'])
        result=self.archive()
        self.assertEqual(result.returncode,0,result.stderr.decode())
        with tarfile.open(fileobj=io.BytesIO(result.stdout)) as archive:
            manifest=json.load(archive.extractfile('manifest.json'))
            self.assertEqual(set(manifest['sidecar_changes']),{'closed.db-wal','closed.db-shm'})
            self.assertNotIn('raw/closed.db-wal',archive.getnames())
        restored,output=self.restore(result.stdout)
        self.assertEqual(restored.returncode,0,restored.stderr.decode())
        with sqlite3.connect(output/'closed.db') as reader:
            self.assertEqual(reader.execute('select * from t').fetchall(),[(1,)])

    def test_writer_close_removes_only_known_sidecars_after_snapshot(self):
        result=self.hook('''
writer=sqlite3.connect(root/'rotating.db')
writer.execute('pragma journal_mode=wal')
writer.execute('create table t(v)'); writer.execute('insert into t values (1)'); writer.commit()
original=tarfile.TarFile.addfile
def close_writer(self,tarinfo,fileobj=None):
    result=original(self,tarinfo,fileobj)
    if tarinfo.name == 'sqlite/rotating.db':writer.close()
    return result
tarfile.TarFile.addfile=close_writer
''')
        self.assertEqual(result.returncode,0,result.stderr.decode())
        with tarfile.open(fileobj=io.BytesIO(result.stdout)) as archive:
            changes=json.load(archive.extractfile('manifest.json'))['sidecar_changes']
            self.assertEqual(set(changes),{'rotating.db-wal','rotating.db-shm'})
            self.assertTrue(all(value['before'] and value['after'] is None for value in changes.values()))
        restored,output=self.restore(result.stdout)
        self.assertEqual(restored.returncode,0,restored.stderr.decode())
        with sqlite3.connect(output/'rotating.db') as reader:
            self.assertEqual(reader.execute('select * from t').fetchall(),[(1,)])

    def test_new_sidecar_link_fifo_alias_and_orphan_are_rejected(self):
        self.database()
        for kind in ('link','fifo','alias','orphan'):
            with self.subTest(kind=kind):
                code='''
original=tarfile.TarFile.addfile
def bad_sidecar(self,tarinfo,fileobj=None):
    result=original(self,tarinfo,fileobj)
    if tarinfo.name == 'sqlite/history.db':
        target=root/'history.db-journal'
        if KIND == 'link': target.symlink_to('history.db')
        elif KIND == 'fifo': os.mkfifo(target)
        elif KIND == 'alias': os.link(root/'history.db',target)
        else: (root/'orphan-wal').write_bytes(b'not a registered SQLite family')
    return result
tarfile.TarFile.addfile=bad_sidecar
'''.replace('KIND',repr(kind))
                result=self.hook(code,timeout=3)
                self.assertNotEqual(result.returncode,0)
                for name in ('history.db-journal','orphan-wal'):
                    (self.volume/name).unlink(missing_ok=True)

    def test_initial_sidecar_alias_is_not_hidden_by_later_removal(self):
        self.database()
        (self.volume/'a-marker').write_bytes(b'')
        os.link(self.volume/'a-marker',self.volume/'history.db-journal')
        result=self.hook('''
original=tarfile.TarFile.addfile
def hide_alias(self,tarinfo,fileobj=None):
    result=original(self,tarinfo,fileobj)
    if tarinfo.name == 'sqlite/history.db': (root/'history.db-journal').unlink()
    return result
tarfile.TarFile.addfile=hide_alias
''')
        self.assertNotEqual(result.returncode,0)

    def throughline_store(self, name, value):
        path = self.volume / 'state/throughline' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))
        return path

    def test_throughline_store_replacement_is_archived_as_one_complete_document(self):
        receipts = 'completed-turn-receipts/' + 'a' * 64 + '.json'
        self.throughline_store(receipts, {'next_sequence': 1})
        self.throughline_store('runtime-errors.json', {'v': 'old'})
        self.throughline_store('runtime-errors.report.state.json', {'v': 'old'})
        self.throughline_store('completed-turn-receipts/.completed-turn-receipts.1.abc.tmp', {})
        (self.volume / 'file').write_bytes(b'ABC')
        result = self.hook('''
import json
state = root / 'state/throughline'
def replace(path, value):
    temporary = path.with_name('.' + path.stem + '.9.def.tmp')
    temporary.write_text(json.dumps(value))
    os.replace(temporary, path)
original_open = os.open
opened = 0
def open_replacing(path, flags, *args, **kwargs):
    global opened
    if pathlib.Path(path) == state / 'runtime-errors.report.state.json':
        opened += 1
        if opened == 1: replace(pathlib.Path(path), {'v': 'classification'})
    return original_open(path, flags, *args, **kwargs)
os.open = open_replacing
original_info = tarfile.TarFile.gettarinfo
def info_replacing(self, name=None, arcname=None, fileobj=None):
    if pathlib.Path(name) == root:
        replace(state / 'runtime-errors.json', {'v': 'new'})
        (state / 'completed-turn-receipts/.completed-turn-receipts.1.abc.tmp').unlink()
    return original_info(self, name, arcname, fileobj)
tarfile.TarFile.gettarinfo = info_replacing
original_walk = os.walk
walks = 0
def walk_replacing(*args, **kwargs):
    global walks
    walks += 1
    if walks == 2: replace(state / 'RECEIPTS', {'next_sequence': 2})
    return original_walk(*args, **kwargs)
os.walk = walk_replacing
'''.replace('RECEIPTS', receipts))
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        with tarfile.open(fileobj=io.BytesIO(result.stdout)) as archive:
            names = archive.getnames()
            self.assertNotIn('raw/state/throughline/completed-turn-receipts/.completed-turn-receipts.1.abc.tmp', names)
            replaced = json.load(archive.extractfile('manifest.json'))['replaced']
        self.assertEqual(set(replaced), {'state/throughline/' + receipts, 'state/throughline/runtime-errors.json', 'state/throughline/runtime-errors.report.state.json'})
        self.assertTrue(all(value['before'] != value['after'] for value in replaced.values()))
        restored, output = self.restore(result.stdout)
        self.assertEqual(restored.returncode, 0, restored.stderr.decode())
        self.assertEqual(json.loads((output / 'state/throughline' / receipts).read_text()), {'next_sequence': 1})
        self.assertEqual(json.loads((output / 'state/throughline/runtime-errors.json').read_text()), {'v': 'new'})
        self.assertEqual(json.loads((output / 'state/throughline/runtime-errors.report.state.json').read_text()), {'v': 'classification'})
        self.assertEqual((output / 'file').read_bytes(), b'ABC')

    def test_json_replacement_outside_throughline_state_still_refuses(self):
        (self.volume / 'state').mkdir()
        (self.volume / 'state/other.json').write_text('{}')
        result = self.hook('''
original = os.walk
calls = 0
def replace(*args, **kwargs):
    global calls
    calls += 1
    if calls == 2:
        (root / 'state/.other.tmp').write_text('{"v":1}')
        os.replace(root / 'state/.other.tmp', root / 'state/other.json')
    return original(*args, **kwargs)
os.walk = replace
''')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'volume entry replaced during archive: state/other.json', result.stderr)


if __name__ == '__main__':
    unittest.main()
