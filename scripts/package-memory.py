#!/usr/bin/env python3
"""Package the fixed six-file memory closure from Git; no npm or stored data."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile
from web_gateway_artifact import MEMORY_FILES, check_archive, require, validate_memory_state, write_archive


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    parser.add_argument('--source', required=True)
    parser.add_argument('--arch', required=True, choices=['amd64', 'arm64'])
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    source = subprocess.check_output(['git', 'rev-parse', '--verify', args.source + '^{commit}'], cwd=repo, text=True).strip()
    require(source == args.source and platform.system() == 'Linux')
    require(subprocess.check_output(['node', '-p', 'process.versions.node.split(".")[0]'], text=True).strip() == '26')
    output = args.output.resolve(); require(not output.exists(), 'GATEWAY_OUTPUT_EXISTS'); output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='memory-package-', dir=output.parent) as temp:
        root = Path(temp); payload = root / 'payload'
        for name in sorted(MEMORY_FILES):
            relative = name.removeprefix('payload/')
            mode = subprocess.check_output(['git', 'ls-tree', source, '--', relative], cwd=repo, text=True).split()[0]
            require(mode in ['100644', '100755'], 'GATEWAY_SOURCE_LINK_INVALID')
            target = root / name; target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(subprocess.check_output(['git', 'show', source + ':' + relative], cwd=repo))
        state = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
            'const m = await import(process.argv[1]); console.log(JSON.stringify(m.MEMORY_STATE_COMPATIBILITY))',
            (payload / 'src/memory/state-compatibility.mjs').as_uri()], text=True, env={'PATH': os.environ['PATH']}))
        validate_memory_state(state)
        staged = root / 'archive.tar.gz'
        write_archive(payload, staged, source, args.arch, component='memory', state_compatibility=state)
        with staged.open('rb') as stream: manifest, manifest_sha = check_archive(stream, source, args.arch, component='memory')
        os.link(staged, output)
    print(json.dumps(dict(archive=str(output), archiveSha256=hashlib.sha256(output.read_bytes()).hexdigest(),
        manifestSha256=manifest_sha, sourceCommit=source, arch=args.arch, files=len(manifest['files']),
        runtime=manifest['runtime'], signed=False, nativeRunner=args.arch == {'x86_64':'amd64','aarch64':'arm64'}.get(platform.machine()))))


if __name__ == '__main__': main()
