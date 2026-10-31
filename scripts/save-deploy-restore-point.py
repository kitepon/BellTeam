"""Store deployment restore points on QNAP; immutable Docker images have one blob."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from datetime import datetime, timezone

BASE = Path('/var/mnt/qnap-backups/main-server/products/bellteam/deploy-restore')
RATE = 10 * 1024 * 1024


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def mount_guard(path):
    for parent in [*reversed(path.parents), path]:
        if parent.is_symlink() or not parent.is_dir():
            raise RuntimeError('NAS ancestor invalid')
    row = json.loads(subprocess.check_output(['findmnt', '-J', '-T', str(path)]))['filesystems'][0]
    if row['target'] != '/var/mnt/qnap-backups' or row['source'] != '192.168.1.3:/server-backups' or row['fstype'] != 'nfs4' or not {'rw', 'hard', 'noexec', 'nosuid', 'nodev', 'sec=sys'} <= set(row['options'].split(',')):
        raise RuntimeError('QNAP mount required; no local fallback')


def identity(path):
    s = path.lstat()
    if not path.is_file() or path.is_symlink():
        raise RuntimeError('archive is not a regular file')
    return {k: getattr(s, k) for k in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')}


def json_save(path, value):
    with path.open('x') as stream:
        os.chmod(path, 0o600)
        json.dump(value, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    sync_dir(path.parent)


def copy_hash(source, target=None, rate=RATE):
    sha, total, started = hashlib.sha256(), 0, time.monotonic()
    while data := source.read(1024 * 1024):
        if target:
            target.write(data)
        sha.update(data)
        total += len(data)
        if rate:
            time.sleep(max(0, total / rate - (time.monotonic() - started)))
    return {'sha256': sha.hexdigest(), 'bytes': total}


def archive(path, command, script=None, rate=RATE):
    partial = path.with_suffix(path.suffix + '.partial')
    try:
        with partial.open('xb') as target:
            os.chmod(partial, 0o600)
            with script.open('rb') if script else open(os.devnull, 'rb') as source:
                process = subprocess.Popen(command, stdin=source, stdout=subprocess.PIPE)
                try:
                    with process.stdout:
                        result = copy_hash(process.stdout, target, rate)
                    if process.wait() != 0:
                        raise RuntimeError('archive producer failed')
                    if result['bytes'] == 0:
                        raise RuntimeError('archive producer returned no bytes')
                    target.flush()
                    os.fsync(target.fileno())
                except BaseException:
                    if process.poll() is None:
                        process.terminate()
                        process.wait()
                    raise
        with partial.open('rb') as source:
            if copy_hash(source, rate=rate) != result:
                raise RuntimeError('NAS archive readback mismatch')
        if path.exists():
            raise RuntimeError('archive already exists')
        partial.rename(path)
        sync_dir(path.parent)
        return {**result, 'identity': identity(path)}
    except BaseException:
        partial.unlink(missing_ok=True)
        sync_dir(path.parent)
        raise



def image_blob(images, image, run=archive):
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
        raise RuntimeError('invalid image identity')
    path = images / (image.replace(':', '-') + '.tar')
    receipt = path.with_suffix('.json')
    if path.exists() or receipt.exists():
        return checked_image_blob(images, image)
    saved = {'image': image, **run(path, ['docker', 'image', 'save', image])}
    json_save(receipt, saved)
    return {**saved, 'path': str(path), 'reused': False}


def read_metadata(path):
    if path.is_symlink() or not path.is_file():
        raise RuntimeError('metadata is not a regular file')
    with path.open('rb') as stream:
        data = stream.read(65537)
    if len(data) > 65536:
        raise RuntimeError('metadata too large')
    return json.loads(data)


def checked_image_blob(images, image):
    if images.is_symlink() or images.resolve(strict=True) != images:
        raise RuntimeError('image directory redirected')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
        raise RuntimeError('invalid image identity')
    path = images / (image.replace(':', '-') + '.tar')
    saved = read_metadata(path.with_suffix('.json'))
    if saved.get('image') != image or saved.get('identity') != identity(path) or not re.fullmatch(r'[0-9a-f]{64}', saved.get('sha256', '')) or saved.get('bytes') != path.stat().st_size or saved['bytes'] <= 0:
        raise RuntimeError('stored image blob changed; inspect before reuse')
    return {**saved, 'path': str(path), 'reused': True}


def validated_points(base):
    points = []
    for point in sorted(base.iterdir()):
        if not re.fullmatch(r'\d{8}T\d{6}\.\d{6}Z', point.name) or not (point / 'restore.json').exists():
            continue
        if point.is_symlink() or {p.name for p in point.iterdir()} != {'restore.json', 'cursor.tar'}:
            raise RuntimeError('restore point scope changed')
        saved = read_metadata(point / 'restore.json')
        cursor = saved['cursor']
        if identity(point / 'cursor.tar') != cursor['identity'] or cursor.get('path') != str(point / 'cursor.tar') or cursor.get('bytes') != cursor['identity']['st_size'] or not re.fullmatch(r'[0-9a-f]{64}', cursor.get('sha256', '')):
            raise RuntimeError('restore payload changed')
        blob = checked_image_blob(base / 'images', saved['image']['image'])
        if any(saved['image'].get(key) != blob[key] for key in ['image', 'path', 'identity', 'sha256', 'bytes']):
            raise RuntimeError('restore image reference mismatch')
        points.append((point, saved))
    return points


def prune_points(base):
    points = validated_points(base)
    retained = {saved['image']['image'] for _, saved in points[-2:]}
    expired = points[:-2]
    if expired:
        json_save(base / ('retention-' + str(time.time_ns()) + '.json'), {'expired': [str(p) for p, _ in expired], 'retained': [str(p) for p, _ in points[-2:]]})
    for point, saved in expired:
        if identity(point / 'cursor.tar') != saved['cursor']['identity']:
            raise RuntimeError('expired payload changed before deletion')
        (point / 'cursor.tar').unlink()
        (point / 'restore.json').unlink()
        point.rmdir()
        sync_dir(base)
    for receipt in (base / 'images').glob('sha256-*.json'):
        if receipt.is_symlink() or receipt.stat().st_size > 65536:
            raise RuntimeError('image receipt invalid')
        saved = json.loads(receipt.read_text())
        if saved['image'] in retained:
            continue
        if receipt.stem != saved['image'].replace(':', '-'):
            raise RuntimeError('image receipt name mismatch')
        blob = receipt.with_suffix('.tar')
        if identity(blob) != saved['identity']:
            raise RuntimeError('expired image changed')
        blob.unlink()
        receipt.unlink()
        sync_dir(receipt.parent)


def main():
    os.umask(0o077)
    mount_guard(BASE.parent)
    BASE.mkdir(mode=0o700, exist_ok=True)
    mount_guard(BASE)
    with (BASE / '.lock').open('a+b') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        images = BASE / 'images'
        images.mkdir(mode=0o700, exist_ok=True)
        mount_guard(images)
        container = json.loads(subprocess.check_output(['docker', 'container', 'inspect', 'bellteam']))[0]
        cid, image = container['Id'], container['Image']
        if not re.fullmatch(r'[0-9a-f]{64}', cid):
            raise RuntimeError('invalid container identity')
        mounts = [m for m in container['Mounts'] if m['Destination'] == '/home/bell/.local']
        if len(mounts) != 1 or mounts[0]['Type'] != 'volume' or mounts[0]['Name'] != 'bellteam_cursor-cli':
            raise RuntimeError('Cursor volume mismatch')
        point = BASE / datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
        point.mkdir(mode=0o700)
        sync_dir(BASE)
        try:
            blob = image_blob(images, image)
            cursor = archive(point / 'cursor.tar', ['docker', 'exec', '-i', '--user', 'bell', cid, '/usr/bin/python3', '-', 'create', '/home/bell/.local'], Path('scripts/archive-live-volume.py'))
            current = json.loads(subprocess.check_output(['docker', 'container', 'inspect', 'bellteam']))[0]
            if current['Id'] != cid or current['Image'] != image:
                raise RuntimeError('source container changed during backup')
            mount_guard(point)
            json_save(point / 'restore.json', {'container': cid, 'image': blob, 'cursor': {**cursor, 'path': str(point / 'cursor.tar')}, 'cursorVolume': 'bellteam_cursor-cli', 'createdAt': datetime.now(timezone.utc).isoformat()})
            prune_points(BASE)
        except BaseException as error:
            json_save(point / 'failed.json', {'errorType': type(error).__name__, 'container': cid, 'image': image})
            raise
        print(str(point))


if __name__ == '__main__':
    main()
