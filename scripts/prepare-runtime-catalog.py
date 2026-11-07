#!/usr/bin/env python3
"""Build the separate runtime catalog bound to the exact main catalog bytes."""
import hashlib
import json
from pathlib import Path
import subprocess
from urllib.parse import urlparse

from update_catalog import MAX_CATALOG, require, strict_json, validate_runtime_catalog

ROOT = Path(__file__).resolve().parents[1]


def validate_formal_assets(release, metadata):
    """Match runtime archive and bundle to assets on their fixed formal release."""
    archive_url = release['artifact']['archive']['url']
    path = urlparse(archive_url).path.split('/')
    require(len(path) >= 2 and path[-3] == 'download', 'UPDATE_RUNTIME_RELEASE_URL_INVALID')
    tag = path[-2]
    require(metadata.get('tag_name') == tag and metadata.get('draft') is False
            and metadata.get('prerelease') is False, 'UPDATE_RUNTIME_NOT_FORMALLY_PUBLISHED')
    assets = metadata.get('assets')
    require(type(assets) is list and len(assets) <= 256, 'UPDATE_RUNTIME_RELEASE_ASSETS_INVALID')
    for kind in ('archive', 'bundle'):
        expected = release['artifact'][kind]
        name = urlparse(expected['url']).path.rsplit('/', 1)[-1]
        matches = [asset for asset in assets if type(asset) is dict and asset.get('name') == name]
        require(len(matches) == 1 and matches[0].get('size') == expected['bytes']
                and matches[0].get('digest') == 'sha256:' + expected['sha256'],
                'UPDATE_RUNTIME_RELEASE_ASSET_MISMATCH')
    return tag


def prepare_runtime_catalog(main_catalog_bytes, runtime_releases, release_metadata=None):
    """Pure builder; release_metadata maps formal release tags to their API records."""
    require(type(main_catalog_bytes) is bytes and 0 < len(main_catalog_bytes) <= MAX_CATALOG,
            'UPDATE_CATALOG_SIZE_INVALID')
    require(type(runtime_releases) is list, 'UPDATE_RUNTIME_RELEASES_INVALID')
    value = dict(schema='bellteam.runtime-catalog.v1',
                 catalogSha256=hashlib.sha256(main_catalog_bytes).hexdigest(),
                 releases=runtime_releases)
    validate_runtime_catalog(value)
    if runtime_releases:
        require(type(release_metadata) is dict, 'UPDATE_RUNTIME_RELEASE_METADATA_MISSING')
        for release in runtime_releases:
            archive_path = urlparse(release['artifact']['archive']['url']).path.split('/')
            tag = archive_path[-2]
            require(tag in release_metadata, 'UPDATE_RUNTIME_RELEASE_METADATA_MISSING')
            validate_formal_assets(release, release_metadata[tag])
    return value


def formal_release(tag):
    return json.loads(subprocess.check_output(
        ['gh', 'api', 'repos/kitepon/BellTeam/releases/tags/' + tag], text=True))


def main():
    main_bytes = (ROOT / 'config/update-catalog.json').read_bytes()
    require(0 < len(main_bytes) <= MAX_CATALOG, 'UPDATE_CATALOG_SIZE_INVALID')
    runtime_releases = strict_json((ROOT / 'config/runtime-releases.json').read_bytes())
    require(type(runtime_releases) is list, 'UPDATE_RUNTIME_RELEASES_INVALID')
    metadata = {}
    for release in runtime_releases:
        # Validate the closed row contract before consulting release metadata.
        validate_runtime_catalog(dict(schema='bellteam.runtime-catalog.v1',
                                      catalogSha256='0' * 64, releases=[release]))
        tag = urlparse(release['artifact']['archive']['url']).path.split('/')[-2]
        if tag not in metadata:
            metadata[tag] = formal_release(tag)
    runtime_catalog = prepare_runtime_catalog(main_bytes, runtime_releases, metadata)
    output = ROOT / 'runtime/update-catalog/runtime-catalog.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(runtime_catalog, separators=(',', ':')) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
