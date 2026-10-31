#!/usr/bin/env python3
"""Archive live files with separate SQLite snapshots; restore into a new directory."""
import io
import json
import os
import sqlite3
import stat
import sys
import tarfile
import tempfile
import time
from pathlib import Path, PurePosixPath

FIELDS = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
SIDECARS = ('-wal', '-shm', '-journal')


def inventory(root):
    result = []
    for current, dirs, files in os.walk(root, followlinks=False, onerror=lambda error: (_ for _ in ()).throw(error)):
        current = Path(current)
        result.append(current)
        for name in sorted(dirs + files):
            path = current / name
            if not path.is_dir() or path.is_symlink():
                result.append(path)
    return result


def create(root):
    if not root.is_dir() or root.is_symlink():
        raise ValueError('expected a directory')
    entries = inventory(root)
    identities = {path: path.lstat() for path in entries}
    databases = set()
    for path, before in identities.items():
        if stat.S_ISREG(before.st_mode):
            with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as stream:
                opened = os.fstat(stream.fileno())
                if not stat.S_ISREG(opened.st_mode) or (before.st_dev, before.st_ino, before.st_mode) != (opened.st_dev, opened.st_ino, opened.st_mode):
                    raise RuntimeError('file replaced during classification: ' + str(path))
                if stream.read(16) == b'SQLite format 3\x00':
                    if before.st_nlink != 1:
                        raise RuntimeError('hard-linked SQLite database cannot be safely archived: ' + str(path))
                    databases.add(path)
    mutable = databases | {Path(str(path) + suffix) for path in databases for suffix in SIDECARS}
    if any(path in identities and not stat.S_ISREG(identities[path].st_mode) for path in mutable):
        raise RuntimeError('SQLite database family must contain regular files')
    observations = {}
    with tarfile.open(fileobj=sys.stdout.buffer, mode='w|', format=tarfile.PAX_FORMAT) as archive:
        for path in entries:
            name = 'raw' if path == root else 'raw/' + str(path.relative_to(root))
            recorded = path.lstat()
            initial = identities[path]
            if (initial.st_dev, initial.st_ino, stat.S_IFMT(initial.st_mode)) != (recorded.st_dev, recorded.st_ino, stat.S_IFMT(recorded.st_mode)):
                raise RuntimeError('volume entry replaced before archive: ' + name)
            info = archive.gettarinfo(str(path), arcname=name)
            if info.isreg():
                with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as stream:
                    before = os.fstat(stream.fileno())
                    fields = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid') if path in mutable else FIELDS
                    if not stat.S_ISREG(before.st_mode) or any(getattr(before, field) != getattr(recorded, field) for field in fields):
                        raise RuntimeError('volume file changed before archive: ' + name)
                    # Physical SQLite copies retain observed bytes only; restore uses the online snapshots below.
                    if path in mutable:
                        info.pax_headers['BELLTEAM.sqlite-copy'] = 'physical-observation-only'
                        with tempfile.TemporaryFile() as spool:
                            remaining = before.st_size
                            deadline = time.monotonic() + 120
                            while remaining:
                                if time.monotonic() > deadline:
                                    raise TimeoutError('SQLite physical observation timed out')
                                data = stream.read(min(remaining, 1024 * 1024))
                                if not data:
                                    break
                                spool.write(data)
                                remaining -= len(data)
                            info.size = before.st_size - remaining
                            observations[str(path.relative_to(root))] = {'limit': before.st_size, 'bytes': info.size}
                            spool.seek(0)
                            archive.addfile(info, spool)
                    else:
                        if before.st_size != info.size:
                            raise RuntimeError('volume file changed before archive: ' + name)
                        archive.addfile(info, stream)
                    after, now = os.fstat(stream.fileno()), path.lstat()
                    fields = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid') if path in mutable else FIELDS
                    if any(getattr(before, field) != getattr(after, field) or getattr(after, field) != getattr(now, field) for field in fields):
                        raise RuntimeError('volume file changed during archive: ' + name)
            else:
                archive.addfile(info)
        for path in sorted(databases):
            before = path.lstat()
            initial = identities[path]
            if not stat.S_ISREG(before.st_mode) or (before.st_dev, before.st_ino) != (initial.st_dev, initial.st_ino) or root.resolve() not in path.resolve().parents:
                raise RuntimeError('SQLite database replaced before snapshot')
            info = archive.gettarinfo(str(path), arcname='sqlite/' + str(path.relative_to(root)))
            deadline = time.monotonic() + 120
            def progress(_status, _remaining, _total):
                if time.monotonic() > deadline:
                    raise TimeoutError('SQLite backup timed out')
            with tempfile.TemporaryDirectory(prefix='bellteam-sqlite-snapshot-') as temp:
                snapshot = Path(temp) / 'snapshot.db'
                source = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=5)
                try:
                    target = sqlite3.connect(snapshot)
                    try:
                        source.backup(target, pages=256, progress=progress, sleep=.05)
                        if target.execute('pragma quick_check').fetchall() != [('ok',)]:
                            raise RuntimeError('SQLite snapshot integrity check failed')
                    finally:
                        target.close()
                finally:
                    source.close()
                info.size = snapshot.stat().st_size
                with snapshot.open('rb') as stream:
                    archive.addfile(info, stream)
        final_entries = inventory(root)
        if set(final_entries) != set(entries):
            raise RuntimeError('volume namespace changed during archive')
        for path in final_entries:
            before, after = identities[path], path.lstat()
            if (before.st_dev, before.st_ino, stat.S_IFMT(before.st_mode)) != (after.st_dev, after.st_ino, stat.S_IFMT(after.st_mode)):
                raise RuntimeError('volume entry replaced during archive')
        manifest = json.dumps({'format': 1, 'databases': [str(path.relative_to(root)) for path in sorted(databases)],
                               'identities': {str(path.relative_to(root)): [identities[path].st_dev, identities[path].st_ino] for path in sorted(databases)},
                               'observations': observations}).encode()
        info = tarfile.TarInfo('manifest.json')
        info.mode, info.size = 0o600, len(manifest)
        archive.addfile(info, io.BytesIO(manifest))


def restore(archive_path, destination):
    if destination.exists() or destination.is_symlink():
        raise ValueError('restore destination must not exist')
    with tarfile.open(archive_path) as archive, tempfile.TemporaryDirectory(prefix='bellteam-volume-restore-', dir=destination.parent) as temp:
        manifest = json.load(archive.extractfile('manifest.json'))
        names = manifest.get('databases')
        if manifest.get('format') != 1 or not isinstance(names, list) or any(not isinstance(name, str) or not name or PurePosixPath(name).is_absolute() or '..' in PurePosixPath(name).parts or str(PurePosixPath(name)) != name for name in names) or len(set(names)) != len(names):
            raise ValueError('invalid SQLite snapshot manifest')
        members = archive.getmembers()
        if len({member.name for member in members}) != len(members):
            raise ValueError('duplicate archive member')
        expected = {'sqlite/' + name for name in names}
        if {member.name for member in members if member.name.startswith('sqlite/')} != expected:
            raise ValueError('SQLite snapshot manifest does not match archive')
        if any(member.name != 'manifest.json' and member.name != 'raw' and not member.name.startswith(('raw/', 'sqlite/')) for member in members):
            raise ValueError('unexpected archive member')
        families = {name + suffix for name in names for suffix in ('', *SIDECARS)}
        if any(not archive.getmember('sqlite/' + name).isreg() or not archive.getmember('raw/' + name).isreg() for name in names):
            raise ValueError('SQLite snapshot or physical observation is not regular')
        def restore_filter(member, directory):
            checked = tarfile.data_filter(member, directory)
            return checked.replace(mode=member.mode & 0o777)
        archive.extractall(temp, members=[member for member in members if not member.name.startswith('raw/') or member.name[4:] not in families], filter=restore_filter)
        raw = Path(temp) / 'raw'
        if raw.is_symlink() or not raw.is_dir():
            raise ValueError('physical archive root must be a directory')
        for path in inventory(raw):
            if path.is_symlink() and not path.resolve().is_relative_to(raw):
                raise ValueError('link escapes the final restored directory')
        for name in names:
            snapshot, original = Path(temp) / 'sqlite' / name, raw / name
            if not snapshot.is_file() or snapshot.is_symlink():
                raise ValueError('SQLite snapshot is not a regular file')
            conn = sqlite3.connect(snapshot.resolve().as_uri() + '?mode=ro&immutable=1', uri=True)
            try:
                if conn.execute('pragma quick_check').fetchall() != [('ok',)]:
                    raise ValueError('SQLite snapshot integrity check failed')
            finally:
                conn.close()
            os.replace(snapshot, original)
        os.rename(raw, destination)


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'create':
        create(Path(sys.argv[2]))
    elif len(sys.argv) == 4 and sys.argv[1] == 'restore':
        restore(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        raise SystemExit('usage: archive-live-volume.py create ROOT | restore ARCHIVE NEW_DESTINATION')
