#!/usr/bin/env python3
"""Create one unsigned, immutable fixed component archive from clean Git and npm inputs."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
from web_gateway_artifact import BUSINESS_FILES, EXECUTION_FILES, CONVERSATION_FILES, check_archive, contract, require, safe_path, write_archive


def validate_members_source(payload):
    path = (payload / 'src/members/state-compatibility.mjs').resolve().as_uri()
    actual = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
        'const m = await import(process.argv[1]); console.log(JSON.stringify(m.MEMBERS_STATE_COMPATIBILITY))', path],
        env={'PATH': os.environ['PATH']}, text=True))
    require(actual == contract('members')[1]['stateCompatibility'], 'MEMBERS_SOURCE_STATE_INCOMPATIBLE')
    return actual


def validate_conversation_source(payload):
    path = (payload / 'src/conversation/state-compatibility.mjs').resolve().as_uri()
    actual = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
        'const m = await import(process.argv[1]); console.log(JSON.stringify(m.CONVERSATION_STATE_COMPATIBILITY))', path],
        env={'PATH': os.environ['PATH']}, text=True))
    require(actual == contract('conversation')[1]['stateCompatibility'], 'CONVERSATION_SOURCE_STATE_INCOMPATIBLE')
    return actual


def main(component):
    contract(component)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    parser.add_argument('--source', required=True)
    parser.add_argument('--arch', required=True, choices=['amd64', 'arm64'])
    args = parser.parse_args()
    args.output = args.output.resolve()
    require(platform.system() == 'Linux', 'GATEWAY_LINUX_RUNNER_REQUIRED')
    repo = Path(__file__).resolve().parents[1]
    source = subprocess.check_output(['git', 'rev-parse', '--verify', args.source + '^{commit}'], cwd=repo, text=True).strip()
    require(source == args.source, 'GATEWAY_SOURCE_MUST_BE_FULL_COMMIT')
    require(subprocess.check_output(['node', '-p', 'process.versions.node.split(".")[0]'], text=True).strip() == '26')
    require(not args.output.exists(), 'GATEWAY_OUTPUT_EXISTS')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='web-gateway-', dir=args.output.parent) as work:
        root = Path(work); payload = root / 'payload'; payload.mkdir()
        paths = ['src', 'package.json', 'package-lock.json']
        if component == 'web-gateway':
            paths += ['web', 'services/subscriptions/product.json', 'services/subscriptions/endpoints.json']
        elif component == 'members':
            paths += ['config/common-agents.md']
        if component == 'execution':
            paths = sorted(name.removeprefix('payload/') for name in EXECUTION_FILES)
        if component in BUSINESS_FILES:
            paths = sorted(name.removeprefix('payload/') for name in BUSINESS_FILES[component])
        if component == 'conversation':
            paths = sorted({*(name.removeprefix('payload/') for name in CONVERSATION_FILES), 'src/direct-log-record.mjs'})
        raw = subprocess.check_output(['git', 'archive', source, *paths], cwd=repo)
        with tarfile.open(fileobj=io.BytesIO(raw)) as tar:
            for item in tar:
                safe_path(item.name)
                require(item.isdir() or item.isfile(), 'GATEWAY_SOURCE_LINK_INVALID')
                target = payload / item.name
                if item.isdir(): target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(tar.extractfile(item).read())
        if component not in ('diagnostics', 'execution', 'conversation'):
            (payload / 'src/distribution-profile.mjs').write_bytes(subprocess.check_output(
                ['git', 'show', source + ':distribution/server/distribution-profile.mjs'], cwd=repo))
        if component == 'members':
            validate_members_source(payload)
        if component == 'conversation':
            validate_conversation_source(payload)
        lock = json.loads((payload / 'package-lock.json').read_text())
        cross = args.arch != {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine())
        if cross:
            # Cross-arch source inputs are safe only for this lock's platform-independent JS.
            require(all(not (p.get('hasInstallScript') or p.get('cpu') or p.get('os'))
                        for name, p in lock['packages'].items() if name and not p.get('dev')), 'GATEWAY_NATIVE_RUNNER_REQUIRED')
        if component != 'usage':
            user_config = root / 'user.npmrc'; user_config.write_text('')
            global_config = root / 'global.npmrc'; global_config.write_text('')
            npm = shutil.which('npm'); require(npm is not None)
            subprocess.run([npm, 'ci', '--omit=dev', '--cache', str(root / 'npm-cache'),
                            '--userconfig', str(user_config), '--globalconfig', str(global_config)], cwd=payload,
                           env={'PATH': os.environ['PATH'], 'CI': 'true', 'npm_config_audit': 'false',
                                'npm_config_fund': 'false', 'npm_config_update_notifier': 'false'},
                           stdout=subprocess.PIPE, check=True, timeout=180)
        if cross:
            for path in (payload / 'node_modules').rglob('*'):
                if path.is_file():
                    with path.open('rb') as file: magic = file.read(4)
                    require(path.suffix != '.node' and magic not in [b'\x7fELF', b'\x00asm']
                            and not magic.startswith(b'MZ'), 'GATEWAY_NATIVE_RUNNER_REQUIRED')
        if component in BUSINESS_FILES or component == 'execution':
            module, exported = ('src/execution-dispatcher.mjs', 'EXECUTION_STATE_COMPATIBILITY') if component == 'execution' else ('src/usage/state-compatibility.mjs', 'USAGE_STATE_COMPATIBILITY') if component == 'usage' else ('src/diagnostics-protocol.mjs', 'DIAGNOSTICS_STATE_COMPATIBILITY')
            actual = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
                'const m = await import(process.argv[1]); console.log(JSON.stringify(m[process.argv[2]]))',
                (payload / module).as_uri(), exported], env={'PATH': os.environ['PATH']}, text=True))
            require(actual == contract(component)[1]['stateCompatibility'], 'MODULE_SOURCE_STATE_INCOMPATIBLE')
        staged = root / 'artifact.tar.gz'
        write_archive(payload, staged, source, args.arch, component=component)
        with staged.open('rb') as file: manifest, manifest_sha = check_archive(file, source, args.arch, component=component)
        os.link(staged, args.output)
    with args.output.open('rb') as file: digest = hashlib.file_digest(file, 'sha256').hexdigest()
    print(json.dumps(dict(archive=str(args.output.resolve()), archiveSha256=digest,
        manifestSha256=manifest_sha, sourceCommit=source, arch=args.arch, files=len(manifest['files']),
        signed=False, nativeRunner=not cross)))

