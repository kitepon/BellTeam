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

# Fixed child import closure plus the author's readonly restore fixture.
CONVERSATION_FILES = frozenset('payload/' + name for name in '''
package-lock.json
package.json
src/agent-launch-error.mjs
src/avatar-value.mjs
src/conversation-background-ipc.mjs
src/conversation-channel.mjs
src/conversation-delivery-release.mjs
src/conversation-entry.mjs
src/conversation-input.mjs
src/conversation-ipc.mjs
src/conversation-locks.mjs
src/conversation-store.mjs
src/conversation-streams.mjs
src/conversation-writer.mjs
src/conversation/authority.mjs
src/conversation/background.mjs
src/conversation/callbacks.mjs
src/conversation/dispatcher.mjs
src/conversation/effects.mjs
src/conversation/native.mjs
src/conversation/observer.mjs
src/conversation/probe-fixture.json
src/conversation/requests.mjs
src/conversation/restore.mjs
src/conversation/results.mjs
src/conversation/routing.mjs
src/conversation/state-compatibility.mjs
src/delivery-tracking.mjs
src/execution-bridge.mjs
src/execution-error.mjs
src/json-file.mjs
src/member-identity.mjs
src/message-assets.mjs
src/messenger.mjs
src/module-ipc.mjs
src/module-streams.mjs
src/notifications-ipc.mjs
src/notifications-locks.mjs
src/observer-check.mjs
src/resume-policy.mjs
src/returned-mcp-error.mjs
src/room-access.mjs
src/room-history.mjs
src/room-messenger.mjs
src/room-registry.mjs
src/room-routing.mjs
src/runtime-home.mjs
src/schedule-definition.mjs
src/schedule-mutations.mjs
src/seat-command.mjs
src/seat-process.mjs
src/self-turns.mjs
src/session-interruption.mjs
src/timeline-index.mjs
src/turn-reports.mjs
src/usage/web-push-schema.mjs
'''.split())


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


BUSINESS_FILES = {
    'usage': {'payload/' + name for name in (
        'config/setup-guide.json',
        'package-lock.json',
        'package.json',
        'services/subscriptions/endpoints.json',
        'services/subscriptions/product.json',
        'src/auth-ui.mjs',
        'src/card-timelines.mjs',
        'src/distribution-profile.mjs',
        'src/feature-settings.mjs',
        'src/harness-auth.mjs',
        'src/json-file.mjs',
        'src/module-ipc.mjs',
        'src/module-locks.mjs',
        'src/module-streams.mjs',
        'src/onboarding.mjs',
        'src/owner-questions.mjs',
        'src/runtime-home.mjs',
        'src/secret-requests.mjs',
        'src/server-address.mjs',
        'src/subscriptions.mjs',
        'src/timeline-index.mjs',
        'src/usage-entry.mjs',
        'src/usage-locks.mjs',
        'src/usage/background-agent-settings.mjs',
        'src/usage/channel-dispatcher.mjs',
        'src/usage/channel-protocol.mjs',
        'src/usage/channel.mjs',
        'src/usage/process-results.mjs',
        'src/usage/process-schema.mjs',
        'src/usage/projection.mjs',
        'src/usage/registry-ports.mjs',
        'src/usage/secret-credentials.mjs',
        'src/usage/onepassword-source.mjs',
        'src/usage/services.mjs',
        'src/usage/state-compatibility.mjs',
        'src/usage/web-push-schema.mjs',
    )},
    'diagnostics': {'payload/' + name for name in (
        'package-lock.json',
        'package.json',
        'src/agent-launch-error.mjs',
        'src/diagnostic-report-context.mjs',
        'src/diagnostics-dispatcher.mjs',
        'src/diagnostics-entry.mjs',
        'src/diagnostics-ipc.mjs',
        'src/diagnostics-locks.mjs',
        'src/diagnostics-protocol.mjs',
        'src/diagnostics.mjs',
        'src/json-file.mjs',
        'src/module-ipc.mjs',
        'src/module-locks.mjs',
        'src/module-streams.mjs',
    )},
    'work-graph': {'payload/' + name for name in (
        'package-lock.json',
        'package.json',
        'src/module-ipc.mjs',
        'src/module-locks.mjs',
        'src/module-streams.mjs',
        'src/work-graph-dispatcher.mjs',
        'src/work-graph-entry.mjs',
        'src/work-graph-ipc.mjs',
        'src/work-graph-locks.mjs',
        'src/work-graph-protocol.mjs',
        'src/work-graph/core.mjs',
        'src/work-graph/projection.mjs',
    )},
    # package/lock come from distribution/lattice (module_artifact_package.py), not the body's root.
    'lattice': {'payload/' + name for name in (
        'package-lock.json',
        'package.json',
        'src/lattice-dispatcher.mjs',
        'src/lattice-entry.mjs',
        'src/lattice-ipc.mjs',
        'src/lattice-locks.mjs',
        'src/lattice-protocol.mjs',
        'src/lattice/cli.mjs',
        'src/lattice/code-chart.mjs',
        'src/lattice/core.mjs',
        'src/lattice/projection.mjs',
        'src/module-ipc.mjs',
        'src/module-locks.mjs',
        'src/module-streams.mjs',
    )},
}

EXECUTION_FILES = {'payload/' + name for name in (
    'config/common-agents.md',
    'package-lock.json',
    'package.json',
    'src/agent-launch-error.mjs',
    'src/aiterm-client.mjs',
    'src/aiterm-hooks.mjs',
    'src/aiterm-transport.mjs',
    'src/aiterm-wait-process.mjs',
    'src/automatic-configuration-application.mjs',
    'src/bot-administration.mjs',
    'src/bot-environment.mjs',
    'src/bot-execution-errors.mjs',
    'src/bot-goals.mjs',
    'src/bot-session-state.mjs',
    'src/capacity-continuation.mjs',
    'src/claude-limit-text.mjs',
    'src/configuration-intents.mjs',
    'src/configuration-request.mjs',
    'src/configuration-requests.mjs',
    'src/current-work.mjs',
    'src/delivery-job.mjs',
    'src/diagnostic-report-context.mjs',
    'src/execution-bridge.mjs',
    'src/execution-dispatcher.mjs',
    'src/execution-error.mjs',
    'src/execution-failure-report.mjs',
    'src/execution-transport.mjs',
    'src/global-instructions.mjs',
    'src/harness-accounts.mjs',
    'src/http-response.mjs',
    'src/idle-sessions.mjs',
    'src/json-file.mjs',
    'src/mcp-request-context.mjs',
    'src/members-admission.mjs',
    'src/members/deletion.mjs',
    'src/members/instructions.mjs',
    'src/model-handoff.mjs',
    'src/module-ipc.mjs',
    'src/owner-profile.mjs',
    'src/remote-seats.mjs',
    'src/resume-pipe.mjs',
    'src/resume-policy.mjs',
    'src/resume-storage.mjs',
    'src/returned-mcp-error.mjs',
    'src/runtime-home.mjs',
    'src/runtime-selection.mjs',
    'src/seat-activity.mjs',
    'src/seat-command.mjs',
    'src/seat-process.mjs',
    'src/seat-turns.mjs',
    'src/session-interruption.mjs',
    'src/stop-failure-report.mjs',
    'src/throughline-context.mjs',
    'src/user-rules.mjs',
)}

BUSINESS_STATE = {
    'usage': dict(settingsFeatures=['routing','callBridge','cloudflare','diagnostics','notifications','webPush','onePassword'], onboardingSchema='bellteam.onboarding.v1', subscriptionSchema='bellteam.subscription.v1', requestEncoding='json-files', secretEncoding='stored-or-private-reference-v2', handoffSchema='bellteam.usage-volatile.v1'),
    'diagnostics': dict(diagnostics='unversioned-rows-array', investigations='optional-fingerprint-map'),
    'work-graph': dict(state='none'),
    'lattice': dict(state='none'),
}

def state_form(value):
    """Form of a published stateCompatibility value: a token, or up to 32 camelCase keys of tokens, small ints or token lists."""
    token = lambda v: type(v) is str and re.fullmatch(r'[A-Za-z0-9._:,/+-]{1,128}', v) is not None
    scalar = lambda v: token(v) or type(v) is int and 0 <= v < 2 ** 31
    if type(value) is str:
        return token(value)
    return (type(value) is dict and 0 < len(value) <= 32 and all(re.fullmatch('[a-z][A-Za-z0-9]{0,63}', k) for k in value)
            and all(scalar(v) or type(v) is list and len(v) <= 32 and all(token(i) for i in v) for v in value.values()))


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
    require(component in ('web-gateway', 'notifications', 'members', 'memory', 'usage', 'diagnostics', 'execution', 'conversation', 'work-graph', 'lattice'), 'MODULE_COMPONENT_INVALID')
    entry = 'payload/src/execution-dispatcher.mjs' if component == 'execution' else 'payload/src/run-memory-runtime.mjs' if component == 'memory' else ENTRY if component == 'web-gateway' else f'payload/src/{component}-entry.mjs'
    runtime = dict(os='linux', nodeMajor=26, parentProtocol=1)
    # Install accepts the module's own signed file list; only the public entry contract is fixed here.
    # The *_FILES sets above select what the packager takes from the module's source commit; they never gate install.
    required = {entry} if component == 'memory' else {entry, 'payload/package.json', 'payload/package-lock.json'}
    if component == 'notifications':
        runtime.update(parentProtocol=2, stateSchema=2)
    elif component == 'execution':
        runtime['stateCompatibility'] = 'bellteam.execution-state.v1'
    elif component in BUSINESS_FILES:
        runtime['stateCompatibility'] = BUSINESS_STATE[component]
    elif component == 'members':
        # Match the writer's existing formats; exchange never authorizes migration.
        runtime['stateCompatibility'] = dict(
            botProfileSchema='bellteam.bot.v8', scheduleSchema='bellteam.schedule.v1',
            ownerProfileSchema='bellteam.owner-profile.v1', deletionReceiptSchema='bellteam.bot-deletion.v1',
            userRulesEncoding='utf8', initializedMarker='.initialized')
    elif component == 'conversation':
        runtime['stateSchema'] = None
        runtime['stateCompatibility'] = dict(
            directRecordSchemas=['bellteam.direct-message.v1', 'bellteam.interim-word.v1', 'bellteam.delivery-status.v1'],
            roomRecordSchemas=['bellteam.room-message.v1', 'bellteam.room-routing-status.v1', 'bellteam.room-delivery-status.v1'],
            roomSchema='bellteam.room.v1', scheduleSchema='bellteam.schedule.v1', selfTurnsSchema='bellteam.self-turns.v1',
            imageMimeTypes=['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
            readerContract='bellteam.conversation-reader.v1')
    return entry, runtime, required


def validate_manifest(value, source=None, arch=None, *, component='web-gateway', state=None):
    """state: the publisher passes a published row's own stateCompatibility; installers leave it None (this body's contract)."""
    require(type(value) is dict and set(value) == {'schema', 'component', 'sourceCommit', 'entry', 'runtime', 'files'})
    entry, fixed_runtime, required = contract(component)
    if state is not None:
        require(state_form(state) and (component == 'memory' or 'stateCompatibility' in fixed_runtime), 'MODULE_STATE_INVALID')
        if component != 'memory': fixed_runtime = {**fixed_runtime, 'stateCompatibility': state}
    require(value['schema'] == f'bellteam.{component}.artifact.v1' and value['component'] == component)
    require(isinstance(value['sourceCommit'], str) and re.fullmatch('[a-f0-9]{40}', value['sourceCommit']))
    require(source is None or value['sourceCommit'] == source, 'GATEWAY_SOURCE_MISMATCH')
    require(value['entry'] == entry)
    runtime = value['runtime']
    require(type(runtime) is dict and set(runtime) == {*fixed_runtime, 'arch', *(['stateCompatibility'] if component == 'memory' else [])})
    if component == 'memory': require(runtime['stateCompatibility'] == state, 'MODULE_STATE_INCOMPATIBLE') if state is not None else validate_memory_state(runtime['stateCompatibility'])
    elif state is not None: require(runtime['stateCompatibility'] == state, 'MODULE_STATE_INCOMPATIBLE')
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
    # A missing import fails the candidate probe before the swap, and the old version keeps serving.
    require(required <= names)
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
    entry, runtime, required = contract(component)
    if component == 'execution': require(EXECUTION_FILES <= paths.keys())
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


def check_archive(stream, source=None, arch=None, *, component='web-gateway', state=None):
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
                manifest = validate_manifest(json.loads(metadata), source, arch, component=component, state=state)
                expected = {f['path']: f for f in manifest['files']}
            else:
                require(name in expected and item.size == expected[name]['bytes'])
                digest = hashlib.sha256()
                for block in iter(lambda: body.read(128 * 1024), b''):
                    digest.update(block)
                require(digest.hexdigest() == expected[name]['sha256'], 'GATEWAY_CONTENT_CHANGED')
    require(manifest is not None and found == {'manifest.json', *expected})
    return manifest, sha256(metadata)
