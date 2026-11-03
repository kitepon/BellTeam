#!/usr/bin/env python3
"""Finite unsigned archive entry probe at UID1000; no database initialization or image claim."""
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from web_gateway_artifact import check_archive, require


def main():
    require(len(sys.argv) == 3 and os.geteuid() == 0, 'MEMORY_PROBE_ARGUMENTS')
    archive, node = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
    arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}[platform.machine()]
    with archive.open('rb') as stream: manifest, _ = check_archive(stream, arch=arch, component='memory')
    root = Path(tempfile.mkdtemp(prefix='memory-probe-', dir=archive.parent)); root.chmod(0o755)
    try:
        with tarfile.open(archive, 'r:gz') as tar:
            for row in manifest['files']:
                path = root / row['path']; path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(tar.extractfile(row['path']).read()); path.chmod(0o444)
        for path, _, _ in os.walk(root / 'payload', topdown=False): os.chmod(path, 0o555)
        data = root / 'empty-data'; data.mkdir(mode=0o555)
        generation = 'unsigned-archive-probe'
        result = subprocess.run([str(node), str(root / manifest['entry'])],
            input=json.dumps(dict(generation=generation, root=str(data), method=None, params=None)),
            encoding='utf8', cwd=data, env={'PATH':'/usr/bin:/bin'}, user=1000, group=1000, extra_groups=[],
            capture_output=True, timeout=15)
        (archive.parent / 'entry-probe.stdout.log').write_text(result.stdout)
        (archive.parent / 'entry-probe.stderr.log').write_text(result.stderr)
        require(result.returncode == 0, 'MEMORY_PROBE_FAILED')
        require(json.loads(result.stdout) == dict(protocolVersion=1, generation=generation,
            stateCompatibility=manifest['runtime']['stateCompatibility'], result=dict(restored=True)), 'MEMORY_PROBE_RESPONSE')
        require(not list(data.iterdir()), 'MEMORY_PROBE_WROTE_DATA')
    finally:
        shutil.rmtree(root)
    (archive.parent / 'entry-probe.json').write_text(json.dumps(dict(accepted=True, uid=1000, osExit=0,
        stateCompatibility=manifest['runtime']['stateCompatibility'], dataUnchanged=True, cleanup=True,
        realSeatC=False, imageOrSwapVerified=False))+'\n')


if __name__ == '__main__': main()
