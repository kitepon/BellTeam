#!/usr/bin/env python3
"""Z-b2 runtime code store: stage verified closures (P4) and commit the next-launch selection (P5).

Canonical diagram: docs/architecture/modules/runtime/runtime-updates.md. Never runs package code,
never touches CLI HOME/Aiterm/Throughline state, never re-selects an older generation on request.
"""
import contextlib
import ctypes
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile
import tempfile

RUNTIME_ROOT = Path('/srv/bellteam/shared/tools/bellteam-runtime')
COMPONENTS = {
    'runtime-aiterm-mcp': {'package': 'aiterm-mcp', 'bins': ['aiterm-mcp'], 'dist': 'lib/node_modules/aiterm-mcp/dist'},
    'runtime-codex': {'package': '@openai/codex', 'bins': ['codex'], 'dist': None},
    'runtime-claude-code': {'package': '@anthropic-ai/claude-code', 'bins': ['claude'], 'dist': None},
    'runtime-throughline': {'package': 'throughline', 'bins': ['throughline'], 'dist': None},
}
GENERATION_SCHEMA = 'bellteam.runtime-generation.v1'
SELECTION_SCHEMA = 'bellteam.runtime-selection.v1'
ARTIFACT_SCHEMA = 'bellteam.runtime.artifact.v1'
MAX_FILES = 60000
MAX_BYTES = 1024 ** 3
SHA = re.compile('[a-f0-9]{64}')
COMMIT = re.compile('[a-f0-9]{40}')


class RuntimeFailure(ValueError):
    def __init__(self, code):
        super().__init__(code); self.code = code


def fail(code):
    raise RuntimeFailure(code)


def require(condition, code='RUNTIME_ARTIFACT_INVALID'):
    if not condition: fail(code)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)


def atomic_json(path, value, mode=0o444):
    path = Path(path)
    with tempfile.NamedTemporaryFile('wb', dir=path.parent, prefix='.' + path.name + '.', delete=False) as out:
        out.write((json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode())
        out.flush(); os.fchmod(out.fileno(), mode); os.fsync(out.fileno())
    os.replace(out.name, path)
    sync_directory(path.parent)


def read_json(path, limit=1024 * 1024):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as source:
        require(stat.S_ISREG(os.fstat(source.fileno()).st_mode), 'RUNTIME_SELECTION_INVALID')
        raw = source.read(limit + 1)
    require(len(raw) <= limit, 'RUNTIME_SELECTION_INVALID')
    return json.loads(raw)


def publish_noreplace(source, target):
    # Linux NOREPLACE: an existing immutable closure is never overwritten.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.renameat2(-100, os.fsencode(source), -100, os.fsencode(target), 1):
        error = ctypes.get_errno()
        if error == errno.EEXIST: return False
        raise OSError(error, os.strerror(error))
    return True


def safe_relative(name):
    parts = PurePosixPath(name).parts
    return (bool(parts) and not name.startswith('/') and '\\' not in name and name == '/'.join(parts)
            and not any(p in ('', '.', '..') for p in parts) and not any(ord(c) < 32 or ord(c) == 127 for c in name))


def validate_manifest(manifest, component, expected, platform):
    """manifest: {schema,component,package,upstreamVersion,sourceCommit,platform,files:[{path,type,bytes?,sha256?,mode?,target?}]}"""
    require(component in COMPONENTS, 'RUNTIME_COMPONENT_INVALID')
    require(type(manifest) is dict and set(manifest) == {'schema', 'component', 'package', 'upstreamVersion', 'sourceCommit', 'platform', 'files'})
    require(manifest['schema'] == ARTIFACT_SCHEMA and manifest['component'] == component
            and manifest['package'] == COMPONENTS[component]['package'] and manifest['sourceCommit'] == expected['sourceCommit'])
    require(type(manifest['upstreamVersion']) is str and re.fullmatch(r'[0-9A-Za-z.+-]{1,64}', manifest['upstreamVersion']))
    require(manifest['platform'] == platform, 'RUNTIME_ABI_INCOMPATIBLE')
    files = manifest['files']
    require(type(files) is list and 0 < len(files) <= MAX_FILES)
    entries, total = {}, 0
    for item in files:
        require(type(item) is dict and type(item.get('path')) is str and item.get('type') in ('file', 'symlink'))
        name = item['path']
        require(safe_relative(name) and name.startswith('prefix/') and name not in entries)
        if item['type'] == 'file':
            require(set(item) == {'path', 'type', 'bytes', 'sha256', 'mode'} and type(item['bytes']) is int and item['bytes'] >= 0
                    and type(item['sha256']) is str and SHA.fullmatch(item['sha256']) and item['mode'] in (0o444, 0o555))
            total += item['bytes']
            require(total <= MAX_BYTES)
        else:
            require(set(item) == {'path', 'type', 'target'} and type(item['target']) is str)
            # npm bin links are relative and must stay inside the prefix.
            resolved = os.path.normpath(os.path.join(os.path.dirname(name), item['target']))
            require(not item['target'].startswith('/') and (resolved == 'prefix' or resolved.startswith('prefix/')))
        entries[name] = item
    # Links are leaves only: nothing is written through a link, so the syntactic in-prefix check above holds for real paths.
    links = {name for name, item in entries.items() if item['type'] == 'symlink'}
    require(not any(str(parent) in links for name in entries for parent in PurePosixPath(name).parents))
    for binary in COMPONENTS[component]['bins']:
        require('prefix/bin/' + binary in entries, 'RUNTIME_ARTIFACT_INVALID')
    dist = COMPONENTS[component]['dist']
    if dist: require(any(path.startswith('prefix/' + dist + '/') for path in entries))
    return entries


def extract(archive_path, receipt, expected, destination, platform):
    """Extract a verified archive into destination; destination ends up holding manifest.json and prefix/."""
    manifest = receipt['manifest']
    entries = validate_manifest(manifest, receipt['component'], expected, platform)
    found = set()
    with tarfile.open(archive_path, 'r:gz') as bundle:
        for member in bundle:
            name = member.name
            require(name not in found and (name == 'manifest.json' or name == 'prefix' or safe_relative(name)), 'RUNTIME_ARTIFACT_INVALID')
            found.add(name)
            if member.isdir():
                require(name == 'prefix' or name.startswith('prefix/'))
                continue
            if name == 'manifest.json':
                require(member.isfile() and member.size <= 64 * 1024 * 1024)
                raw = bundle.extractfile(member).read()
                require(hashlib.sha256(raw).hexdigest() == receipt['manifestSha256'] and json.loads(raw) == manifest, 'RUNTIME_ARTIFACT_INVALID')
                (destination / name).write_bytes(raw); os.chmod(destination / name, 0o444)
                continue
            item = entries.get(name)
            require(item is not None)
            path = destination / name
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            if item['type'] == 'symlink':
                require(member.issym() and member.linkname == item['target'])
                os.symlink(item['target'], path)
                continue
            require(member.isfile() and member.size == item['bytes'])
            content, digest, size = bundle.extractfile(member), hashlib.sha256(), 0
            with path.open('xb') as out:
                while block := content.read(1024 * 1024):
                    digest.update(block); size += len(block); out.write(block)
                require(size == item['bytes'] and digest.hexdigest() == item['sha256'], 'RUNTIME_ARTIFACT_INVALID')
                out.flush(); os.fchmod(out.fileno(), item['mode']); os.fsync(out.fileno())
    require('manifest.json' in found and set(entries) <= found)
    for root, _, _ in os.walk(destination, topdown=False):
        os.chmod(root, 0o755)
        sync_directory(root)


def stage(root, component, archive_path, receipt, expected, platform):
    """P4: verified archive -> packages/<component>/<archiveSha256>/ (immutable). Returns the closure path."""
    require(component in COMPONENTS, 'RUNTIME_COMPONENT_INVALID')
    require(set(expected) == {'archiveSha256', 'sourceCommit', 'signerCommit'} and SHA.fullmatch(expected['archiveSha256'])
            and COMMIT.fullmatch(expected['sourceCommit']) and COMMIT.fullmatch(expected['signerCommit']))
    require(receipt.get('archiveSha256') == expected['archiveSha256'] and receipt.get('component') == component)
    packages = Path(root) / 'packages' / component
    packages.mkdir(parents=True, exist_ok=True, mode=0o755)
    target = packages / expected['archiveSha256']
    if target.is_dir() and not target.is_symlink():
        stored = read_json(target / 'receipt.json')
        require(stored == receipt, 'RUNTIME_ARTIFACT_INVALID')
        return target
    work = Path(tempfile.mkdtemp(prefix='.staging-', dir=packages))
    try:
        extract(archive_path, receipt, expected, work, platform)
        atomic_json(work / 'receipt.json', receipt)
        os.chmod(work, 0o755)
        if not publish_noreplace(work, target):
            require(read_json(target / 'receipt.json') == receipt, 'RUNTIME_ARTIFACT_INVALID')
        sync_directory(packages)
        return target
    finally:
        if work.exists():
            for path, _, _ in os.walk(work): os.chmod(path, 0o700)
            import shutil; shutil.rmtree(work)


def generation_id(vector):
    return hashlib.sha256(json.dumps(vector, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def read_current(root):
    """-> (generationId or None, components vector). None = no selection was ever established (builtin)."""
    root = Path(root)
    try: pointer = read_json(root / 'current.json')
    except FileNotFoundError: return None, {}
    require(type(pointer) is dict and set(pointer) == {'schema', 'generation'} and pointer['schema'] == SELECTION_SCHEMA
            and SHA.fullmatch(pointer['generation']), 'RUNTIME_SELECTION_INVALID')
    generation = read_json(root / 'generations' / (pointer['generation'] + '.json'))
    require(type(generation) is dict and set(generation) == {'schema', 'components', 'jobId'} and generation['schema'] == GENERATION_SCHEMA
            and type(generation['components']) is dict and set(generation['components']) <= set(COMPONENTS)
            and generation_id(generation['components']) == pointer['generation'], 'RUNTIME_SELECTION_INVALID')
    return pointer['generation'], generation['components']


@contextlib.contextmanager
def selection_lock(root):
    # Protects: two jobs overwriting each other's selection. Exit: flock released when the block ends.
    fd = os.open(Path(root) / 'selection.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def commit(root, component, closure, job_id, expected_generation):
    """P5: replace exactly one component of the expected vector and publish current.json atomically."""
    root = Path(root)
    receipt = read_json(Path(closure) / 'receipt.json')
    manifest = receipt['manifest']
    require(Path(closure).parent == root / 'packages' / component and receipt['component'] == component)
    with selection_lock(root):
        actual, vector = read_current(root)
        if actual != expected_generation: fail('RUNTIME_SELECTION_CHANGED')
        vector = dict(vector)
        vector[component] = {'archiveSha256': receipt['archiveSha256'], 'sourceCommit': manifest['sourceCommit'],
                             'upstreamVersion': manifest['upstreamVersion']}
        target = generation_id(vector)
        (root / 'generations').mkdir(exist_ok=True, mode=0o755)
        path = root / 'generations' / (target + '.json')
        if not path.exists():
            atomic_json(path, {'schema': GENERATION_SCHEMA, 'components': vector, 'jobId': job_id})
        atomic_json(root / 'current.json', {'schema': SELECTION_SCHEMA, 'generation': target})
        readback, _ = read_current(root)
        if readback != target: fail('RUNTIME_SELECTION_COMMIT_FAILED')
        return target


def recover(root, target_generation):
    """Worker lost in swapping: ready only when current.json already names the job's target."""
    actual, _ = read_current(root)
    return 'ready' if actual == target_generation else 'failed'
