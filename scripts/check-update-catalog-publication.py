#!/usr/bin/env python3
"""Require already-public fixed targets before formal catalog publication; never promote them."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from update_catalog import MAX_CATALOG, strict_json, validate_catalog, require


def download(url, headers=None):
    with urlopen(Request(url, headers=headers or {}), timeout=30) as response:
        raw = response.read(4 * MAX_CATALOG + 1)
    require(len(raw) <= 4 * MAX_CATALOG, 'UPDATE_PUBLICATION_RESPONSE_LIMIT')
    return raw


def main():
    raw = Path('config/update-catalog.json').read_bytes()
    require(len(raw) <= MAX_CATALOG)
    catalog = validate_catalog(strict_json(raw))
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
    tag = 'updates-' + catalog['publishedAt'].replace('-','').replace(':','').split('.')[0].removesuffix('Z') + 'Z'
    print(json.dumps(dict(tag=tag, catalogSha256=hashlib.sha256(raw).hexdigest())))


if __name__ == '__main__':
    main()
