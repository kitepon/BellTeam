#!/usr/bin/env python3
"""Require already-public fixed targets before formal catalog publication; never promote them."""
from http.client import IncompleteRead
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlparse
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from update_catalog import MAX_CATALOG, strict_json, validate_catalog, validate_members_archive, validate_notifications_archive, validate_memory_archive, validate_conversation_archive, require


TRANSIENT_HTTP = {408, 425, 429, 500, 502, 503, 504}
RETRY_WINDOW = 240  # inside the job's 10 min; the next ordinary publisher run is the exit after it


def download(url, headers=None, maximum=4 * MAX_CATALOG):
    deadline = time.monotonic() + RETRY_WINDOW
    delay = 2
    while True:
        try:
            with urlopen(Request(url, headers=headers or {}), timeout=30) as response:
                raw = response.read(maximum + 1)
            break
        except HTTPError as error:
            if error.code not in TRANSIENT_HTTP or time.monotonic() + delay > deadline:
                raise
        except (URLError, OSError, IncompleteRead):
            if time.monotonic() + delay > deadline:
                raise
        time.sleep(delay)
        delay = min(delay * 2, 30)
    require(len(raw) <= maximum, 'UPDATE_PUBLICATION_RESPONSE_LIMIT')
    return raw


def download_asset(item):
    raw = download(item['url'], maximum=item['bytes'])
    require(len(raw) == item['bytes'] and hashlib.sha256(raw).hexdigest() == item['sha256'], 'UPDATE_RELEASE_CONTENT_MISMATCH')
    return raw


def verify_members_release(release):
    from module_artifact_package import validate_members_source
    from module_artifact_verifier import policy_for, verify_signature
    from web_gateway_artifact import check_archive
    root = Path(__file__).resolve().parents[1]
    validate_members_source(root)
    # A published row is checked against its own signed archive, not against this source's current state.
    state = release['compatibility']['stateCompatibility']
    artifact = release['artifact']
    with tempfile.TemporaryDirectory(prefix='members-publication-') as directory:
        archive = Path(directory) / 'archive.tar.gz'; archive.write_bytes(download_asset(artifact['archive']))
        bundle = Path(directory) / 'bundle.json'; bundle.write_bytes(download_asset(artifact['bundle']))
        with archive.open('rb') as a, bundle.open('rb') as b, (root / 'config/web-gateway-trusted-root.jsonl').open('rb') as t:
            verify_signature(a, b, t, policy_for('members'), source=release['sourceCommit'], signer=artifact['signerCommit'])
            manifest, _ = check_archive(a, release['sourceCommit'], release['platform']['arch'], component='members', state=state)
        validate_members_archive(release, manifest, state)


def verify_memory_release(release):
    from module_artifact_verifier import policy_for, verify_signature
    from web_gateway_artifact import check_archive
    root = Path(__file__).resolve().parents[1]
    state = release['compatibility']['stateCompatibility']
    artifact = release['artifact']
    with tempfile.TemporaryDirectory(prefix='memory-publication-') as directory:
        archive = Path(directory) / 'archive.tar.gz'; archive.write_bytes(download_asset(artifact['archive']))
        bundle = Path(directory) / 'bundle.json'; bundle.write_bytes(download_asset(artifact['bundle']))
        with archive.open('rb') as a, bundle.open('rb') as b, (root / 'config/web-gateway-trusted-root.jsonl').open('rb') as t:
            verify_signature(a, b, t, policy_for('memory'), source=release['sourceCommit'], signer=artifact['signerCommit'])
            manifest, _ = check_archive(a, release['sourceCommit'], release['platform']['arch'], component='memory', state=state)
        validate_memory_archive(release, manifest, state)


def verify_notifications_release(release):
    from module_artifact_verifier import policy_for, verify_signature
    from web_gateway_artifact import check_archive
    root = Path(__file__).resolve().parents[1]
    artifact = release['artifact']
    with tempfile.TemporaryDirectory(prefix='notifications-publication-') as directory:
        archive = Path(directory) / 'archive.tar.gz'; archive.write_bytes(download_asset(artifact['archive']))
        bundle = Path(directory) / 'bundle.json'; bundle.write_bytes(download_asset(artifact['bundle']))
        with archive.open('rb') as a, bundle.open('rb') as b, (root / 'config/web-gateway-trusted-root.jsonl').open('rb') as t:
            verify_signature(a, b, t, policy_for('notifications'), source=release['sourceCommit'], signer=artifact['signerCommit'])
            manifest, _ = check_archive(a, release['sourceCommit'], release['platform']['arch'], component='notifications')
        validate_notifications_archive(release, manifest)


def verify_conversation_release(release):
    from module_artifact_package import validate_conversation_source
    from module_artifact_verifier import policy_for, verify_signature
    from web_gateway_artifact import check_archive
    root = Path(__file__).resolve().parents[1]
    validate_conversation_source(root)
    state = release['compatibility']['stateCompatibility']
    artifact = release['artifact']
    with tempfile.TemporaryDirectory(prefix='conversation-publication-') as directory:
        archive = Path(directory) / 'archive.tar.gz'; archive.write_bytes(download_asset(artifact['archive']))
        bundle = Path(directory) / 'bundle.json'; bundle.write_bytes(download_asset(artifact['bundle']))
        with archive.open('rb') as a, bundle.open('rb') as b, (root / 'config/web-gateway-trusted-root.jsonl').open('rb') as t:
            verify_signature(a, b, t, policy_for('conversation'), source=release['sourceCommit'], signer=artifact['signerCommit'])
            manifest, _ = check_archive(a, release['sourceCommit'], release['platform']['arch'], component='conversation', state=state)
        validate_conversation_archive(release, manifest, state)

def main():
    raw = Path('config/update-catalog.json').read_bytes()
    require(len(raw) <= MAX_CATALOG)
    catalog = validate_catalog(strict_json(raw), strict=True)
    token = None
    for release in catalog['releases']:
        artifact = release['artifact']
        if release['componentId'] == 'container':
            if token is None:
                token = json.loads(download('https://ghcr.io/token?service=ghcr.io&scope=repository:kitepon/bellteam-server:pull'))['token']
            headers = {'Authorization':'Bearer '+token, 'Accept':'application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json'}
            base = 'https://ghcr.io/v2/kitepon/bellteam-server/'
            index = download(base+'manifests/latest', headers)
            require('sha256:'+hashlib.sha256(index).hexdigest() == release['versionId'], 'UPDATE_CONTAINER_NOT_STABLE')
            descriptor = next(m for m in json.loads(index)['manifests'] if m['platform']['os'] == release['platform']['os'] and m['platform']['architecture'] == release['platform']['arch'])
            manifest = download(base+'manifests/'+descriptor['digest'], headers)
            require('sha256:'+hashlib.sha256(manifest).hexdigest() == descriptor['digest'])
            config_descriptor = json.loads(manifest)['config']
            config = download(base+'blobs/'+config_descriptor['digest'], headers)
            require('sha256:'+hashlib.sha256(config).hexdigest() == config_descriptor['digest'])
            require(json.loads(config)['config']['Labels']['org.opencontainers.image.revision'] == release['sourceCommit'])
        else:
            tag = urlparse(artifact['archive']['url']).path.split('/')[-2]
            response = subprocess.check_output(['gh','api','repos/kitepon/BellTeam/releases/tags/'+tag])
            public = json.loads(response)
            require(public['draft'] is False and public['prerelease'] is False, 'UPDATE_MODULE_NOT_FORMALLY_PUBLISHED')
            for kind in ['archive','bundle']:
                expected = artifact[kind]; name = urlparse(expected['url']).path.rsplit('/',1)[1]
                matches = [a for a in public['assets'] if a['name'] == name]
                require(len(matches) == 1 and matches[0]['size'] == expected['bytes']
                        and matches[0]['digest'] == 'sha256:'+expected['sha256'], 'UPDATE_RELEASE_ASSET_MISMATCH')
            if release['componentId'] == 'memory':
                verify_memory_release(release)
            elif release['componentId'] == 'members':
                verify_members_release(release)
            elif release['componentId'] == 'conversation':
                verify_conversation_release(release)
            elif release['componentId'] == 'notifications':
                verify_notifications_release(release)
    tag = 'updates-' + catalog['publishedAt'].replace('-','').replace(':','').split('.')[0].removesuffix('Z') + 'Z'
    print(json.dumps(dict(tag=tag, catalogSha256=hashlib.sha256(raw).hexdigest())))


if __name__ == '__main__':
    main()
