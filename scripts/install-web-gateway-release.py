#!/usr/bin/env python3
"""Fixed root helper: publish one authenticated gateway release without adopting it."""
import contextlib
import ctypes
import errno
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import stat
import subprocess
import tarfile
import tempfile

ROOT_UID = 0
SERVER_GID = 1001
PRIVATE_ROOT = Path('/srv/bellteam-private')
INCOMING_ROOT = Path('/srv/bellteam-web-gateway-incoming')
ARCHIVE_LIMIT = 512 * 1024 * 1024
BUNDLE_LIMIT = 16 * 1024 * 1024


def fail(code):
    raise ValueError(code)


def expectation(version_id, source, signer):
    if not re.fullmatch('[a-f0-9]{64}', version_id) or not all(re.fullmatch('[a-f0-9]{40}', s) for s in [source, signer]):
        fail('GATEWAY_INSTALL_ARGUMENTS')
    return dict(archiveSha256=version_id, sourceCommit=source, signerCommit=signer)


def directory(path, create=False):
    if create:
        try:
            path.mkdir(mode=0o755)
            path.chmod(0o755)
        except FileExistsError:
            pass
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != ROOT_UID or info.st_mode & 0o7022:
        fail('GATEWAY_INSTALL_DIRECTORY')
    return info


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_file(path, data, mode=0o444):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as out:
            out.write(data)
            out.flush()
        os.fchmod(fd, mode)
        os.fsync(fd)
    finally:
        os.close(fd)


def snapshot(source_dir, name, target, limit):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source_dir)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
            fail('GATEWAY_INSTALL_INPUT')
        with os.fdopen(fd, 'rb', closefd=False) as incoming, target.open('xb') as out:
            size = 0
            while block := incoming.read(1024 * 1024):
                size += len(block)
                if size > limit:
                    fail('GATEWAY_INSTALL_INPUT')
                out.write(block)
            out.flush()
            os.fchmod(out.fileno(), 0o400)
            os.fsync(out.fileno())
        after = os.fstat(fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) or size != before.st_size:
            fail('GATEWAY_INSTALL_INPUT_CHANGED')
    finally:
        os.close(fd)


def verify(archive, bundle, expected, component='web-gateway'):
    if component not in ('web-gateway', 'notifications', 'members', 'memory', 'usage', 'diagnostics', 'execution', 'conversation'):
        fail('GATEWAY_INSTALL_COMPONENT')
    verifier = {'web-gateway':'verify-web-gateway.py','notifications':'verify-notifications.py','members':'verify-members.py','memory':'verify-memory.py','usage':'verify-usage.py','diagnostics':'verify-diagnostics.py','execution':'verify-execution.py','conversation':'verify-conversation.py'}[component]
    child = subprocess.Popen(['/usr/bin/python3', '/app/scripts/' + verifier, str(archive), str(bundle), str(expected)],
                             env={'PATH': '/usr/local/bin:/usr/bin:/bin'}, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, close_fds=True)
    try:
        output, _ = child.communicate(timeout=120)
    except BaseException:
        try:
            os.killpg(child.pid, signal.SIGTERM)
            child.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.communicate()
        except ProcessLookupError:
            child.communicate()
        raise
    if child.returncode:
        fail('GATEWAY_INSTALL_VERIFICATION_FAILED')
    return json.loads(output)


def remove_stage(path):
    directory(path)
    for root, names, _ in os.walk(path, followlinks=False):
        for name in names:
            directory(Path(root) / name)
        os.chmod(root, 0o700)
    shutil.rmtree(path)


def publish(source, target):
    # Linux NOREPLACE is required; never emulate it with overwrite-capable rename.
    libc = ctypes.CDLL(None, use_errno=True)
    if not hasattr(libc, 'renameat2'):
        fail('GATEWAY_INSTALL_NOREPLACE_UNSUPPORTED')
    if libc.renameat2(-100, os.fsencode(source), -100, os.fsencode(target), 1):
        error = ctypes.get_errno()
        if error == errno.EEXIST:
            fail('GATEWAY_RELEASE_EXISTS')
        raise OSError(error, os.strerror(error))


def extract(archive, receipt, expected, destination, component='web-gateway'):
    if component not in ('web-gateway', 'notifications', 'members', 'memory', 'usage', 'diagnostics', 'execution', 'conversation'):
        fail('GATEWAY_INSTALL_COMPONENT')
    if set(receipt) != {'schema', 'archiveSha256', 'manifestSha256', 'manifest', 'verification'} or (
        receipt['schema'] != f'bellteam.{component}.verification.v1'
        or receipt['archiveSha256'] != expected['archiveSha256']
        or receipt['verification'] != {'method': 'github-oidc-attestation', 'repositoryId': '1404510084'}):
        fail('GATEWAY_INSTALL_RECEIPT')
    manifest = receipt['manifest']
    if manifest.get('sourceCommit') != expected['sourceCommit'] or manifest.get('component') != component:
        fail('GATEWAY_INSTALL_RECEIPT')
    if component == 'notifications' and (manifest.get('schema') != 'bellteam.notifications.artifact.v1'
            or manifest.get('entry') != 'payload/src/notifications-entry.mjs'
            or manifest.get('runtime', {}).get('parentProtocol') != 2
            or manifest.get('runtime', {}).get('stateSchema') != 2):
        fail('GATEWAY_INSTALL_RECEIPT')
    if component in ('members', 'memory', 'usage', 'diagnostics', 'execution', 'conversation'):
        spec = importlib.util.spec_from_file_location('artifact_contract', Path(__file__).with_name('web_gateway_artifact.py'))
        contract = importlib.util.module_from_spec(spec); spec.loader.exec_module(contract)
        try: contract.validate_manifest(manifest, component=component)
        except Exception: fail('GATEWAY_INSTALL_RECEIPT')
    files = {}
    if not isinstance(manifest.get('files'), list) or not 0 < len(manifest['files']) <= 20000:
        fail('GATEWAY_INSTALL_MEMBER')
    total = 0
    for item in manifest['files']:
        name = item['path']
        parts = name.split('/')
        if not name.startswith('payload/') or any(p in ['', '.', '..'] for p in parts) or '\\' in name or any(ord(c) < 32 or ord(c) == 127 for c in name) or name in files:
            fail('GATEWAY_INSTALL_MEMBER')
        if type(item.get('bytes')) is not int or item['bytes'] < 0:
            fail('GATEWAY_INSTALL_MEMBER')
        total += item['bytes']
        if total > ARCHIVE_LIMIT:
            fail('GATEWAY_INSTALL_MEMBER')
        files[name] = item
    found, seen = set(), set()
    with tarfile.open(archive, 'r:gz') as bundle:
        for member in bundle:
            name = member.name
            if name in seen or name.startswith('/') or any(p in ['', '.', '..'] for p in name.split('/')) or '\\' in name:
                fail('GATEWAY_INSTALL_MEMBER')
            seen.add(name)
            if member.isdir():
                if name != 'payload' and not name.startswith('payload/'):
                    fail('GATEWAY_INSTALL_MEMBER')
                continue
            if not member.isfile() or name != 'manifest.json' and name not in files:
                fail('GATEWAY_INSTALL_MEMBER')
            content = bundle.extractfile(member)
            if name == 'manifest.json':
                raw = content.read(8 * 1024 * 1024 + 1)
                if len(raw) > 8 * 1024 * 1024 or hashlib.sha256(raw).hexdigest() != receipt['manifestSha256'] or json.loads(raw) != manifest:
                    fail('GATEWAY_INSTALL_MANIFEST_CHANGED')
                write_file(destination / name, raw)
                continue
            item = files[name]
            if member.size != item['bytes']:
                fail('GATEWAY_INSTALL_CONTENT_CHANGED')
            path = destination / name
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            digest, size = hashlib.sha256(), 0
            with path.open('xb') as out:
                while block := content.read(1024 * 1024):
                    digest.update(block); size += len(block); out.write(block)
                if size != item['bytes'] or digest.hexdigest() != item['sha256']:
                    fail('GATEWAY_INSTALL_CONTENT_CHANGED')
                out.flush(); os.fchmod(out.fileno(), 0o444); os.fsync(out.fileno())
            found.add(name)
    if found != set(files) or 'manifest.json' not in seen:
        fail('GATEWAY_INSTALL_MEMBER')
    installation = dict(schema=f'bellteam.{component}.installation.v1', component=component,
                        archiveSha256=expected['archiveSha256'], manifestSha256=receipt['manifestSha256'],
                        sourceCommit=expected['sourceCommit'], verification=receipt['verification'])
    write_file(destination / 'installation.json', (json.dumps(installation) + '\n').encode())
    for root, _, _ in os.walk(destination, topdown=False):
        os.chmod(root, 0o555)
        sync_directory(root)


def verify_memory_code(target, manifest):
    expected = {item['path']: item for item in manifest['files']}
    directories = {'.', 'payload'}
    for name in expected:
        directories.update(str(parent) for parent in PurePosixPath(name).parents)
    found = set()
    for root, names, files in os.walk(target, followlinks=False):
        relative = Path(root).relative_to(target).as_posix()
        info = directory(Path(root))
        if relative not in directories or stat.S_IMODE(info.st_mode) != 0o555: fail('MEMORY_CODE_DIRECTORY')
        for name in names: directory(Path(root) / name)
        for name in files:
            path = Path(root) / name; key = path.relative_to(target).as_posix()
            if key not in expected: fail('MEMORY_CODE_INVENTORY')
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, 'rb') as stream:
                info = os.fstat(stream.fileno()); item = expected[key]
                if not stat.S_ISREG(info.st_mode) or info.st_uid != ROOT_UID or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o444:
                    fail('MEMORY_CODE_FILE')
                if info.st_size != item['bytes'] or hashlib.file_digest(stream, 'sha256').hexdigest() != item['sha256']:
                    fail('MEMORY_CODE_CONTENT')
            found.add(key)
    if found != set(expected): fail('MEMORY_CODE_INVENTORY')


def publish_memory_code(private_root, stage, output, manifest, version_id):
    code_root = private_root / 'memory-code'
    if stat.S_IMODE(directory(code_root).st_mode) != 0o555: fail('MEMORY_CODE_ROOT')
    target = code_root / version_id
    if os.path.lexists(target):
        verify_memory_code(target, manifest)
        # An authenticated identical orphan may finish its private receipt; never overwrite code.
        output.chmod(0o700)
        remove_stage(output / 'payload')
    else:
        code = stage / 'code'; code.mkdir(mode=0o700)
        output.chmod(0o700)
        os.rename(output / 'payload', code / 'payload')
        code.chmod(0o555); sync_directory(code)
        publish(code, target)
        sync_directory(code_root)
    output.chmod(0o555); sync_directory(output)


def inspect_execution_release(private_root, expected, arch):
    """Read the fixed release without importing payload code or repairing any file."""
    def immutable_file(path, limit):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            before = os.fstat(fd)
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != ROOT_UID or before.st_nlink != 1
                    or stat.S_IMODE(before.st_mode) != 0o444 or before.st_size > limit):
                fail('GATEWAY_RELEASE_FILE_INVALID')
            with os.fdopen(fd, 'rb', closefd=False) as stream: raw = stream.read(limit + 1)
            after, linked = os.fstat(fd), path.lstat()
            identity = lambda st: (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
            if identity(before) != identity(after) or identity(after) != identity(linked) or len(raw) != before.st_size:
                fail('GATEWAY_RELEASE_CONTENT_CHANGED')
            return raw
        finally:
            os.close(fd)

    for parent in [private_root, private_root / 'execution', private_root / 'execution/releases']:
        directory(parent)
    target = private_root / 'execution/releases' / expected['archiveSha256']
    try: info = directory(target)
    except FileNotFoundError: return None
    if stat.S_IMODE(info.st_mode) != 0o555: fail('GATEWAY_RELEASE_DIRECTORY_INVALID')
    if {path.name for path in target.iterdir()} != {'installation.json', 'manifest.json', 'payload'}:
        fail('GATEWAY_RELEASE_INVENTORY_INVALID')
    installation = json.loads(immutable_file(target / 'installation.json', 65536))
    metadata = immutable_file(target / 'manifest.json', 8 * 1024 * 1024)
    manifest_sha = hashlib.sha256(metadata).hexdigest()
    if installation != dict(schema='bellteam.execution.installation.v1', component='execution',
            archiveSha256=expected['archiveSha256'], manifestSha256=manifest_sha,
            sourceCommit=expected['sourceCommit'],
            verification=dict(method='github-oidc-attestation', repositoryId='1404510084')):
        fail('GATEWAY_RELEASE_INSTALLATION_INVALID')
    spec = importlib.util.spec_from_file_location('inspection_artifact_contract', Path(__file__).with_name('web_gateway_artifact.py'))
    contract = importlib.util.module_from_spec(spec); spec.loader.exec_module(contract)
    manifest = contract.validate_manifest(json.loads(metadata), expected['sourceCommit'], arch, component='execution')
    expected_files = {row['path']: row for row in manifest['files']}
    directories = {'payload'}
    for name in expected_files:
        directories.update(str(parent) for parent in PurePosixPath(name).parents if str(parent) != '.')
    found = set()
    for root, names, files in os.walk(target / 'payload', followlinks=False):
        path = Path(root); relative = path.relative_to(target).as_posix()
        if relative not in directories or stat.S_IMODE(directory(path).st_mode) != 0o555:
            fail('GATEWAY_RELEASE_DIRECTORY_INVALID')
        for name in names:
            child = path / name
            if child.relative_to(target).as_posix() not in directories or stat.S_IMODE(directory(child).st_mode) != 0o555:
                fail('GATEWAY_RELEASE_DIRECTORY_INVALID')
        for name in files:
            child = path / name; relative = child.relative_to(target).as_posix()
            row = expected_files.get(relative)
            if row is None: fail('GATEWAY_RELEASE_INVENTORY_INVALID')
            raw = immutable_file(child, row['bytes'])
            if len(raw) != row['bytes'] or hashlib.sha256(raw).hexdigest() != row['sha256']:
                fail('GATEWAY_RELEASE_CONTENT_CHANGED')
            found.add(relative)
    if found != set(expected_files): fail('GATEWAY_RELEASE_INVENTORY_INVALID')
    return manifest_sha


def install(private_root, incoming_root, expected, component_name='web-gateway'):
    if component_name not in ('web-gateway', 'notifications', 'members', 'memory', 'usage', 'diagnostics', 'execution', 'conversation'):
        fail('GATEWAY_INSTALL_COMPONENT')
    info = directory(private_root)
    if info.st_gid != SERVER_GID or stat.S_IMODE(info.st_mode) != 0o750:
        fail('GATEWAY_INSTALL_PRIVATE_ROOT')
    with contextlib.ExitStack() as resources:
        private = os.open(private_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        resources.callback(os.close, private)
        fcntl.flock(private, fcntl.LOCK_SH)
        opened, linked = os.fstat(private), private_root.lstat()
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino) or (linked.st_dev, linked.st_ino) != (info.st_dev, info.st_ino):
            fail('GATEWAY_INSTALL_PRIVATE_CHANGED')
        component = private_root / component_name
        directory(component, create=True)
        lock = os.open(component / '.install.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        with os.fdopen(lock, 'rb') as held:
            st = os.fstat(held.fileno())
            if not stat.S_ISREG(st.st_mode) or st.st_uid != ROOT_UID or st.st_nlink != 1 or stat.S_IMODE(st.st_mode) != 0o600:
                fail('GATEWAY_INSTALL_LOCK')
            fcntl.flock(held, fcntl.LOCK_EX)
            releases = component / 'releases'; directory(releases, create=True)
            for path in component.iterdir():
                if re.fullmatch(r'\.staging-[a-zA-Z0-9_-]+', path.name):
                    remove_stage(path)
            target = releases / expected['archiveSha256']
            if os.path.lexists(target):
                fail('GATEWAY_RELEASE_EXISTS')
            stage = Path(tempfile.mkdtemp(prefix='.staging-', dir=component))
            try:
                root_fd = os.open(incoming_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    source_fd = os.open(expected['archiveSha256'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
                    try:
                        for name, limit in [('archive.tar.gz', ARCHIVE_LIMIT), ('bundle.json', BUNDLE_LIMIT)]:
                            snapshot(source_fd, name, stage / name, limit)
                    finally:
                        os.close(source_fd)
                finally:
                    os.close(root_fd)
                expectation_path = stage / 'expectation.json'
                write_file(expectation_path, (json.dumps(expected) + '\n').encode(), 0o400)
                receipt = (verify(stage / 'archive.tar.gz', stage / 'bundle.json', expectation_path)
                           if component_name == 'web-gateway' else verify(stage / 'archive.tar.gz', stage / 'bundle.json', expectation_path, component_name))
                output = stage / 'release'; output.mkdir(mode=0o700)
                extract(stage / 'archive.tar.gz', receipt, expected, output, component_name)
                if component_name == 'memory':
                    publish_memory_code(private_root, stage, output, receipt['manifest'], expected['archiveSha256'])
                publish(output, target)
                sync_directory(releases)
                return {'versionId': expected['archiveSha256'], 'installed': True}
            finally:
                remove_stage(stage)


def main(component='web-gateway'):
    import sys
    if len(sys.argv) != 4:
        fail('GATEWAY_INSTALL_ARGUMENTS')
    expected = expectation(*sys.argv[1:])
    if any(value != 0 for value in [os.getuid(), os.geteuid(), os.getgid(), os.getegid()]):
        fail('GATEWAY_INSTALL_ROOT_REQUIRED')
    os.umask(0o077)
    incoming = INCOMING_ROOT if component == 'web-gateway' else Path('/srv/bellteam-' + component + '-incoming')
    print(json.dumps(install(PRIVATE_ROOT, incoming, expected, component)))


if __name__ == '__main__':
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        main()
    except BaseException as error:
        import sys
        code = str(error) if isinstance(error, ValueError) and re.fullmatch('[A-Z][A-Z_0-9]*', str(error)) else 'GATEWAY_INSTALL_FAILED'
        print(code, file=sys.stderr)
        sys.exit(1)
