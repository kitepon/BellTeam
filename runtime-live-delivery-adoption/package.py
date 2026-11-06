#!/usr/bin/env python3
"""Build or inspect the fixed 421d delivery-policy sidecar, never install it."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile
from urllib.parse import urljoin

BASE = '421d2a9f3a900cd73991d86511307d2e596a3711'
ROOT = 'runtime-live-delivery-adoption'
MODULES = {'AitermTransport': ('aiterm-transport.mjs', ['ensure', 'memberOperation', 'requireDeliveryKnown', 'submit', 'dispatch']),
           'BotSessionState': ('bot-session-state.mjs', ['awaitUnboundAdmission', 'requireDeliveryKnown'])}
FILES = {'source/aiterm-transport.mjs', 'source/bot-session-state.mjs', 'policy/aiterm-transport.mjs',
         'policy/bot-session-state.mjs', 'src/adopter.mjs', 'src/client.mjs', 'profile.json'}
MAXIMUM = 2 * 1024 * 1024


def require(value, code='LIVE_SIDECAR_INVALID'):
    if not value:
        raise ValueError(code)


def sha(value):
    return hashlib.sha256(value).hexdigest()


def profile_valid(profile):
    require(set(profile) == {'schema', 'baseSourceCommit', 'backportSourceCommit', 'modules'})
    require(profile['schema'] == 'bellteam.live-delivery-profile.v1' and profile['baseSourceCommit'] == BASE
            and re.fullmatch('[a-f0-9]{40}', profile['backportSourceCommit']) and len(profile['modules']) == 2)
    for module, (class_name, (name, methods)) in zip(profile['modules'], MODULES.items(), strict=True):
        require(set(module) == {'class', 'file', 'beforeFileSha256', 'sourceFileSha256', 'methods'}
                and module['class'] == class_name and module['file'] == name
                and all(re.fullmatch('[a-f0-9]{64}', module[k]) for k in ['beforeFileSha256', 'sourceFileSha256'])
                and [m['method'] for m in module['methods']] == methods)
        for method in module['methods']:
            require(set(method) == {'class', 'method', 'role', 'before', 'after', 'descriptor'}
                    and method['class'] == class_name
                    and method['role'] == ('old-closure-compatibility' if method['method'] == 'requireDeliveryKnown' else 'replacement')
                    and method['descriptor'] == dict(writable=True, enumerable=False, configurable=True))
            for side in ['before', 'after']:
                require(set(method[side]) == {'bytes', 'sha256'} and type(method[side]['bytes']) is int
                        and 0 < method[side]['bytes'] <= 65536 and re.fullmatch('[a-f0-9]{64}', method[side]['sha256']))


def project_imports(raw, name):
    text = raw.decode('utf-8')
    require(not re.search(r'\bimport\s*\(', text) and not re.search(r'^import\s*[\'"]', text, re.M), 'LIVE_DYNAMIC_IMPORT_UNSUPPORTED')
    pattern = re.compile(r'^((?:import|export) [^\n]*? from )([\'"])(\.[^\'"\n]+)\2', re.M)

    def replace(match):
        url = urljoin('file:///app/src/' + name, match[3])
        require(url.startswith('file:///app/src/') and re.fullmatch(r'file:///app/src/[a-zA-Z0-9_./-]+\.mjs', url), 'LIVE_IMPORT_OUTSIDE_BASE')
        return match[1] + match[2] + url + match[2]

    projected, count = pattern.subn(replace, text)
    require(count > 0 and not pattern.search(projected), 'LIVE_IMPORT_PROJECTION_FAILED')
    return projected.encode()


def inspect_archive(path, source, arch):
    require(re.fullmatch('[a-f0-9]{40}', source) and arch in ('amd64', 'arm64'))
    require(path.stat().st_size <= MAXIMUM)
    files = {}
    with tarfile.open(path, 'r:gz') as archive:
        total = 0
        for member in archive:
            require(member.name in FILES | {'manifest.json'} and member.name not in files
                    and member.isfile() and member.uid == member.gid == 0 and member.mode == 0o444
                    and not member.pax_headers and 0 < member.size <= 131072)
            total += member.size
            require(total <= MAXIMUM)
            files[member.name] = archive.extractfile(member).read(member.size + 1)
            require(len(files[member.name]) == member.size)
    require(set(files) == FILES | {'manifest.json'})
    manifest = json.loads(files.pop('manifest.json'))
    require(set(manifest) == {'schema', 'sourceCommit', 'signerCommit', 'platform', 'profile', 'files'}
            and manifest['schema'] == 'bellteam.live-delivery-policy.v1'
            and manifest['sourceCommit'] == manifest['signerCommit'] == source
            and manifest['platform'] == {'os': 'linux', 'arch': arch, 'nodeMajor': 26}
            and set(manifest['files']) == FILES)
    profile = manifest['profile']
    profile_valid(profile)
    require(profile == json.loads(files['profile.json']))
    for name, raw in files.items():
        require(manifest['files'][name] == {'bytes': len(raw), 'sha256': sha(raw)})
    for module in profile['modules']:
        raw = files['source/' + module['file']]
        require(sha(raw) == module['sourceFileSha256'])
        require(project_imports(raw, module['file']) == files['policy/' + module['file']])
    with tarfile.open(path, 'r:gz') as archive:
        manifest_raw = archive.extractfile('manifest.json').read()
    return dict(schema='bellteam.live-delivery-package.v1', sourceCommit=source, signerCommit=source,
                archiveSha256=sha(path.read_bytes()), manifestSha256=sha(manifest_raw),
                platform=manifest['platform'], manifest=manifest)


def build(repo, source, arch, output):
    require(re.fullmatch('[a-f0-9]{40}', source) and arch in ('amd64', 'arm64'))
    require(subprocess.check_output(['git', 'rev-parse', source + '^{commit}'], cwd=repo, text=True).strip() == source)

    def git_file(name):
        raw = subprocess.check_output(['git', 'show', source + ':' + ROOT + '/' + name], cwd=repo)
        require(0 < len(raw) <= 131072)
        return raw

    profile_raw = git_file('profile/source.json')
    profile = json.loads(profile_raw)
    profile_valid(profile)
    files = {'profile.json': profile_raw, 'src/adopter.mjs': git_file('src/adopter.mjs'), 'src/client.mjs': git_file('src/client.mjs')}
    for module in profile['modules']:
        raw = git_file('profile/' + module['file'])
        require(sha(raw) == module['sourceFileSha256'], 'LIVE_BACKPORT_BYTES_CHANGED')
        files['source/' + module['file']] = raw
        files['policy/' + module['file']] = project_imports(raw, module['file'])
    manifest = dict(schema='bellteam.live-delivery-policy.v1', sourceCommit=source, signerCommit=source,
                    platform=dict(os='linux', arch=arch, nodeMajor=26), profile=profile,
                    files={name: dict(bytes=len(raw), sha256=sha(raw)) for name, raw in sorted(files.items())})
    files['manifest.json'] = (json.dumps(manifest, sort_keys=True, separators=(',', ':')) + '\n').encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('xb') as destination, gzip.GzipFile(fileobj=destination, mode='wb', mtime=0, filename='') as compressed:
        with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as archive:
            for name, raw in sorted(files.items()):
                item = tarfile.TarInfo(name)
                item.mode = 0o444; item.size = len(raw); item.uid = item.gid = item.mtime = 0
                archive.addfile(item, io.BytesIO(raw))
    return inspect_archive(output, source, arch)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--arch', required=True, choices=['amd64', 'arm64'])
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--output', type=Path)
    action.add_argument('--check', type=Path)
    args = parser.parse_args()
    result = inspect_archive(args.check, args.source, args.arch) if args.check else build(Path(__file__).resolve().parents[1], args.source, args.arch, args.output)
    print(json.dumps(result, separators=(',', ':')))
