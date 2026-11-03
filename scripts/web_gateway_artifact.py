"""Fixed Web gateway, notifications and members content contracts; this module never authenticates or installs a release."""
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import tarfile

MAX_ARCHIVE = 512 * 1024**2
MAX_CONTENT = 512 * 1024**2
MAX_MANIFEST = 8 * 1024**2
MAX_BUNDLE = 16 * 1024**2
MAX_FILES = 20000
ENTRY = 'payload/src/http-gateway-entry.mjs'


def require(condition, code='GATEWAY_ARTIFACT_INVALID'):
    if not condition:
        raise ValueError(code)


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def safe_path(name):
    require(isinstance(name, str) and name and not re.search(r'[\\\x00-\x1f\x7f]', name))
    path = PurePosixPath(name)
    require(not path.is_absolute() and str(path) == name and all(p not in ['', '.', '..'] for p in name.split('/')))
    return name


MEMORY_FILES = {'payload/' + name for name in (
    'src/run-memory-runtime.mjs', 'src/memory/factory.mjs', 'src/memory/dispatcher.mjs',
    'src/memory/state-compatibility.mjs', 'src/memory-service.mjs', 'src/memory-search.mjs')}


def validate_memory_state(value):
    fixed = dict(memoryUserVersion=0, knowledgeUserVersion=0,
        memoryRequiredSchemaSha256='aac945fb2c594987168317fd857233fb41274072ad6b0d032563459fb4b3733f',
        knowledgeRequiredSchemaSha256='7197ac37c820132a47c4404887df9880058e504db9d42a255b726ebed5d8eccd',
        knowledgeEncoding='utf8', knowledgeFrontmatterFields='id,title,source,created_at,confidence,tags')
    require(type(value) is dict and set(value) == {*fixed, 'searchIndexVersion'}
            and all(type(value[k]) is type(v) and value[k] == v for k, v in fixed.items())
            and type(value['searchIndexVersion']) is str
            and re.fullmatch(r'1:[0-9]+(?:\.[0-9]+){1,3}', value['searchIndexVersion']), 'MEMORY_STATE_INCOMPATIBLE')
    return value


def contract(component):
    require(component in ('web-gateway', 'notifications', 'members', 'memory'), 'MODULE_COMPONENT_INVALID')
    entry = 'payload/src/run-memory-runtime.mjs' if component == 'memory' else ENTRY if component == 'web-gateway' else f'payload/src/{component}-entry.mjs'
    runtime = dict(os='linux', nodeMajor=26, parentProtocol=1)
    required = {entry, 'payload/package.json', 'payload/package-lock.json'}
    if component == 'web-gateway':
        required.update({'payload/web/assets.mjs', 'payload/services/subscriptions/product.json',
                         'payload/services/subscriptions/endpoints.json'})
    elif component == 'notifications':
        runtime.update(parentProtocol=2, stateSchema=2)
    elif component == 'memory':
        required = MEMORY_FILES
    else:
        # Match the writer's existing formats; exchange never authorizes migration.
        runtime['stateCompatibility'] = dict(
            botProfileSchema='bellteam.bot.v8', scheduleSchema='bellteam.schedule.v1',
            ownerProfileSchema='bellteam.owner-profile.v1', deletionReceiptSchema='bellteam.bot-deletion.v1',
            userRulesEncoding='utf8', initializedMarker='.initialized')
        required.update({'payload/config/common-agents.md', 'payload/src/members/state-compatibility.mjs'})
    return entry, runtime, required


def validate_manifest(value, source=None, arch=None, *, component='web-gateway'):
    require(type(value) is dict and set(value) == {'schema', 'component', 'sourceCommit', 'entry', 'runtime', 'files'})
    entry, fixed_runtime, required = contract(component)
    require(value['schema'] == f'bellteam.{component}.artifact.v1' and value['component'] == component)
    require(isinstance(value['sourceCommit'], str) and re.fullmatch('[a-f0-9]{40}', value['sourceCommit']))
    require(source is None or value['sourceCommit'] == source, 'GATEWAY_SOURCE_MISMATCH')
    require(value['entry'] == entry)
    runtime = value['runtime']
    require(type(runtime) is dict and set(runtime) == {*fixed_runtime, 'arch', *(['stateCompatibility'] if component == 'memory' else [])})
    if component == 'memory': validate_memory_state(runtime['stateCompatibility'])
    require(runtime['arch'] in ['amd64', 'arm64'] and all(type(runtime[key]) is type(wanted)
            and runtime[key] == wanted for key, wanted in fixed_runtime.items()))
    require(arch is None or runtime['arch'] == arch, 'GATEWAY_ARCH_MISMATCH')
    require(type(value['files']) is list and 0 < len(value['files']) <= MAX_FILES)
    names = set()
    total = 0
    for file in value['files']:
        require(type(file) is dict and set(file) == {'path', 'bytes', 'sha256'})
        name = safe_path(file['path'])
        require(name.startswith('payload/') and name not in names)
        require(type(file['bytes']) is int and 0 <= file['bytes'] <= MAX_CONTENT)
        require(isinstance(file['sha256'], str) and re.fullmatch('[a-f0-9]{64}', file['sha256']))
        names.add(name)
        total += file['bytes']
    require(total <= MAX_CONTENT)
    require(names == required if component == 'memory' else required <= names)
    return value


def write_archive(payload, output, source, arch, *, component='web-gateway', state_compatibility=None):
    payload = Path(payload).resolve()
    inventory = []
    paths = {}
    for path in sorted(payload.rglob('*')):
        if path.is_dir():
            require(not path.is_symlink(), 'GATEWAY_LINK_INVALID')
            continue
        target = path.resolve()
        require(target.is_relative_to(payload) and target.is_file(), 'GATEWAY_LINK_INVALID')
        name = safe_path('payload/' + path.relative_to(payload).as_posix())
        data = target.read_bytes()
        inventory.append(dict(path=name, bytes=len(data), sha256=sha256(data)))
        paths[name] = target
    entry, runtime, _ = contract(component)
    if component == 'memory': runtime['stateCompatibility'] = validate_memory_state(state_compatibility)
    else: require(state_compatibility is None)
    manifest = validate_manifest(dict(schema=f'bellteam.{component}.artifact.v1', component=component,
        sourceCommit=source, entry=entry, runtime={**runtime, 'arch': arch}, files=inventory), component=component)
    metadata = (json.dumps(manifest, sort_keys=True, separators=(',', ':')) + '\n').encode()
    require(len(metadata) <= MAX_MANIFEST)
    expected_files = {f['path']: f for f in inventory}
    with Path(output).open('xb') as stream:
        with gzip.GzipFile(filename='', mode='wb', fileobj=stream, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w|', format=tarfile.USTAR_FORMAT) as tar:
                for name in ['manifest.json', *paths]:
                    data = metadata if name == 'manifest.json' else paths[name].read_bytes()
                    if name != 'manifest.json':
                        expected = expected_files[name]
                        require(len(data) == expected['bytes'] and sha256(data) == expected['sha256'], 'GATEWAY_CONTENT_CHANGED')
                    item = tarfile.TarInfo(name)
                    item.size = len(data)
                    item.mode = 0o444
                    tar.addfile(item, io.BytesIO(data))
    require(Path(output).stat().st_size <= MAX_ARCHIVE)
    return manifest


def check_archive(stream, source=None, arch=None, *, component='web-gateway'):
    stream.seek(0)
    found = set()
    total = 0
    manifest = None
    with tarfile.open(fileobj=stream, mode='r|gz') as tar:
        for item in tar:
            name = safe_path(item.name)
            require(item.isfile() and not item.sparse and name not in found)
            found.add(name)
            require(len(found) <= MAX_FILES + 1 and 0 <= item.size <= MAX_CONTENT)
            total += item.size
            require(total <= MAX_CONTENT + MAX_MANIFEST)
            body = tar.extractfile(item)
            if manifest is None:
                require(name == 'manifest.json' and item.size <= MAX_MANIFEST)
                metadata = body.read()
                manifest = validate_manifest(json.loads(metadata), source, arch, component=component)
                expected = {f['path']: f for f in manifest['files']}
            else:
                require(name in expected and item.size == expected[name]['bytes'])
                digest = hashlib.sha256()
                for block in iter(lambda: body.read(128 * 1024), b''):
                    digest.update(block)
                require(digest.hexdigest() == expected[name]['sha256'], 'GATEWAY_CONTENT_CHANGED')
    require(manifest is not None and found == {'manifest.json', *expected})
    return manifest, sha256(metadata)
