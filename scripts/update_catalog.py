"""Non-executable formal release catalog. No root-state mutation or product execution."""
from datetime import datetime, timezone
import json
import re
from urllib.request import Request, urlopen

MAX_CATALOG = 1024 * 1024
MAX_LIFETIME = 7 * 24 * 60 * 60
FUTURE_SKEW = 300
REPOSITORY = 'kitepon/BellTeam'
WORKFLOW = 'kitepon/BellTeam/.github/workflows/publish-update-catalog.yml'
POLICY = dict(schema='bellteam.update-catalog.verification-policy.v1', repository=REPOSITORY,
              repositoryId='1404510084', signerWorkflow=WORKFLOW, sourceRef='refs/heads/main',
              predicateType='https://slsa.dev/provenance/v1')


def require(value, code='UPDATE_CATALOG_INVALID'):
    if not value:
        raise ValueError(code)


def exact(value, keys):
    require(type(value) is dict and set(value) == set(keys.split(',')))


def hexadecimal(value, size):
    return type(value) is str and re.fullmatch('[a-f0-9]{' + str(size) + '}', value) is not None


def timestamp(value):
    require(type(value) is str and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z', value))
    return datetime.fromisoformat(value.removesuffix('Z') + '+00:00').timestamp()


def strict_json(raw):
    def pairs(values):
        result = {}
        for key, value in values:
            require(key not in result, 'UPDATE_CATALOG_DUPLICATE_KEY')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: require(False))


def validate_notifications_compatibility(value):
    exact(value, 'nodeMajor,parentProtocol,stateSchema,containerUpdate')
    require(type(value['nodeMajor']) is int and value['nodeMajor'] == 26
            and type(value['parentProtocol']) is int and value['parentProtocol'] == 2
            and type(value['stateSchema']) is int and value['stateSchema'] == 2
            and value['containerUpdate'] is None, 'UPDATE_NOTIFICATIONS_ABI_INCOMPATIBLE')
    return value


def validate_notifications_archive(release, manifest):
    from web_gateway_artifact import validate_manifest
    require(release['componentId'] == 'notifications')
    compatibility = validate_notifications_compatibility(release['compatibility'])
    validate_manifest(manifest, release['sourceCommit'], release['platform']['arch'], component='notifications')
    runtime = manifest['runtime']
    require(release['platform']['os'] == runtime['os']
            and all(compatibility[key] == runtime[key] for key in ['nodeMajor', 'parentProtocol', 'stateSchema']),
            'UPDATE_NOTIFICATIONS_ARCHIVE_INCOMPATIBLE')
    return manifest


def validate_members_compatibility(value):
    from web_gateway_artifact import contract
    exact(value, 'nodeMajor,parentProtocol,stateSchema,containerUpdate,stateCompatibility')
    require(type(value['nodeMajor']) is int and value['nodeMajor'] == 26
            and type(value['parentProtocol']) is int and value['parentProtocol'] == 1
            and value['stateSchema'] is None and value['containerUpdate'] is None)
    require(type(value['stateCompatibility']) is dict
            and value['stateCompatibility'] == contract('members')[1]['stateCompatibility'], 'UPDATE_MEMBERS_STATE_INCOMPATIBLE')
    return value


def validate_members_archive(release, manifest, consumer_state):
    from web_gateway_artifact import contract, validate_manifest
    require(release['componentId'] == 'members')
    compatibility = validate_members_compatibility(release['compatibility'])
    validate_manifest(manifest, release['sourceCommit'], release['platform']['arch'], component='members')
    require(consumer_state == contract('members')[1]['stateCompatibility'], 'UPDATE_MEMBERS_CONSUMER_UNSUPPORTED')
    runtime = manifest['runtime']
    require(release['platform']['os'] == runtime['os']
            and compatibility['nodeMajor'] == runtime['nodeMajor']
            and compatibility['parentProtocol'] == runtime['parentProtocol']
            and compatibility['stateCompatibility'] == runtime['stateCompatibility'] == consumer_state,
            'UPDATE_MEMBERS_ARCHIVE_INCOMPATIBLE')
    return manifest


def validate_memory_compatibility(value):
    from web_gateway_artifact import validate_memory_state
    exact(value, 'nodeMajor,parentProtocol,stateSchema,containerUpdate,stateCompatibility')
    require(type(value['nodeMajor']) is int and value['nodeMajor'] == 26
            and type(value['parentProtocol']) is int and value['parentProtocol'] == 1
            and value['stateSchema'] is None and value['containerUpdate'] is None)
    validate_memory_state(value['stateCompatibility'])
    return value


def validate_memory_archive(release, manifest, consumer_state):
    from web_gateway_artifact import validate_manifest, validate_memory_state
    require(release['componentId'] == 'memory')
    compatibility = validate_memory_compatibility(release['compatibility'])
    validate_manifest(manifest, release['sourceCommit'], release['platform']['arch'], component='memory')
    validate_memory_state(consumer_state)
    runtime = manifest['runtime']
    require(release['platform']['os'] == runtime['os']
            and compatibility['nodeMajor'] == runtime['nodeMajor']
            and compatibility['parentProtocol'] == runtime['parentProtocol']
            and compatibility['stateCompatibility'] == runtime['stateCompatibility'] == consumer_state,
            'UPDATE_MEMORY_ARCHIVE_INCOMPATIBLE')
    return manifest


def validate_catalog(value, *, now=None):
    exact(value, 'schema,publishedAt,expiresAt,releases,revokedCatalogs')
    require(value['schema'] == 'bellteam.update-catalog.v1')
    published, expiry = timestamp(value['publishedAt']), timestamp(value['expiresAt'])
    now = datetime.now(timezone.utc).timestamp() if now is None else now
    require(0 < expiry - published <= MAX_LIFETIME, 'UPDATE_CATALOG_EXPIRY_INVALID')
    require(published <= now + FUTURE_SKEW, 'UPDATE_CATALOG_FROM_FUTURE')
    require(now < expiry, 'UPDATE_CATALOG_EXPIRED')
    revoked = value['revokedCatalogs']
    require(type(revoked) is list and len(revoked) <= 1024 and all(hexadecimal(v, 64) for v in revoked)
            and len(set(revoked)) == len(revoked))
    releases = value['releases']
    require(type(releases) is list and len(releases) <= 128)
    seen = set()
    for release in releases:
        exact(release, 'componentId,sourceCommit,versionId,platform,artifact,compatibility,changes')
        component = release['componentId']
        require(component in ['container', 'web-gateway', 'notifications', 'members', 'memory'])
        require(hexadecimal(release['sourceCommit'], 40))
        platform = release['platform']; exact(platform, 'os,arch')
        require(platform['os'] == 'linux' and platform['arch'] in ['amd64', 'arm64'])
        key = component, platform['arch']; require(key not in seen); seen.add(key)
        compatibility = release['compatibility']
        if component == 'notifications':
            validate_notifications_compatibility(compatibility)
        elif component == 'memory':
            validate_memory_compatibility(compatibility)
        elif component == 'members':
            validate_members_compatibility(compatibility)
        else:
            exact(compatibility, 'nodeMajor,parentProtocol,stateSchema,containerUpdate')
            require(all(v is None or type(v) is int and 0 < v <= 65535 for v in compatibility.values()))
        changes = release['changes']
        require(type(changes) is list and len(changes) <= 16 and all(type(t) is str and 0 < len(t) <= 1000
                and not re.search(r'[\x00-\x1f\x7f]', t) for t in changes))
        artifact = release['artifact']
        if component == 'container':
            exact(artifact, 'kind,reference')
            require(artifact['kind'] == 'oci-index' and type(release['versionId']) is str
                    and re.fullmatch('sha256:[a-f0-9]{64}', release['versionId']))
            require(artifact['reference'] == 'ghcr.io/kitepon/bellteam-server@' + release['versionId'])
        else:
            exact(artifact, 'kind,archive,bundle,signerCommit')
            require(artifact['kind'] == 'archive' and hexadecimal(release['versionId'], 64)
                    and hexadecimal(artifact['signerCommit'], 40))
            for kind, limit in [('archive', 512 * 1024**2), ('bundle', 16 * 1024**2)]:
                item = artifact[kind]; exact(item, 'url,sha256,bytes')
                require(hexadecimal(item['sha256'], 64) and type(item['bytes']) is int and 0 < item['bytes'] <= limit)
            require(artifact['archive']['sha256'] == release['versionId'])
            filename = component + '-' + release['sourceCommit'] + '-linux-' + platform['arch'] + r'\.tar\.gz'
            require(type(artifact['archive']['url']) is str and re.fullmatch(
                r'https://github\.com/kitepon/BellTeam/releases/download/updates-\d{8}T\d{6}Z/' + filename,
                artifact['archive']['url']))
            require(artifact['bundle']['url'] == artifact['archive']['url'] + '.sigstore.json')
    return value


def publication_candidates(records):
    require(type(records) is list and len(records) <= 100, 'UPDATE_PUBLICATIONS_INVALID')
    found = []
    for record in records:
        if type(record) is not dict or record.get('draft') is not False or record.get('prerelease') is not False:
            continue
        tag = record.get('tag_name')
        if type(tag) is not str or not re.fullmatch(r'updates-\d{8}T\d{6}Z', tag):
            continue
        assets = record.get('assets')
        require(type(assets) is list and len(assets) <= 256)
        names = [a.get('name') for a in assets if type(a) is dict]
        if names.count('catalog.json') == names.count('catalog.json.sigstore.json') == 1:
            base = 'https://github.com/kitepon/BellTeam/releases/download/' + tag + '/catalog.json'
            found.append(dict(tag=tag, catalogUrl=base, bundleUrl=base + '.sigstore.json'))
    return found[:10]


def discover_publications():
    # Release metadata is only an untrusted selector; callers must authenticate the returned bytes.
    request = Request('https://api.github.com/repos/kitepon/BellTeam/releases?per_page=100',
                      headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'bellteam-update-catalog'})
    with urlopen(request, timeout=30) as response:
        raw = response.read(4 * MAX_CATALOG + 1)
    require(len(raw) <= 4 * MAX_CATALOG, 'UPDATE_PUBLICATIONS_TOO_LARGE')
    return publication_candidates(strict_json(raw))
