#!/usr/bin/env python3
"""Finite unsigned engine probe; synthetic ports, actual extracted factory at UID1001."""
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
    require(len(sys.argv) == 3 and os.geteuid() == 0, 'EXECUTION_PROBE_ARGUMENTS')
    archive, node = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(strict=True)
    arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine())
    require(platform.system() == 'Linux' and arch, 'EXECUTION_NATIVE_RUNNER_REQUIRED')
    with archive.open('rb') as stream: manifest, _ = check_archive(stream, arch=arch, component='execution')
    # The other UID must not traverse the checkout's private ancestors.
    root = Path(tempfile.mkdtemp(prefix='execution-probe-', dir='/tmp')); root.chmod(0o755)
    result = None
    try:
        with tarfile.open(archive, 'r:gz') as tar:
            for row in manifest['files']:
                target = root / row['path']; target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(tar.extractfile(row['path']).read()); target.chmod(0o444)
        for directory, _, _ in os.walk(root / 'payload', topdown=False): os.chmod(directory, 0o555)
        guest = root / 'guest.mjs'; shutil.copyfile(Path(__file__).with_name('execution-archive-guest.mjs'), guest); guest.chmod(0o444)
        data = root / 'empty-data'; data.mkdir(mode=0o555)
        command = [str(node), str(guest), str(root / 'payload'), str(data)]
        try:
            result = subprocess.run(command, cwd=data, env={}, user=1001, group=1001, extra_groups=[],
                                    capture_output=True, text=True, timeout=30)
        except subprocess.TimeoutExpired as error:
            (archive.parent / 'entry-probe.stdout.log').write_bytes(error.stdout or b'')
            (archive.parent / 'entry-probe.stderr.log').write_bytes(error.stderr or b'')
            raise
        (archive.parent / 'entry-probe.stdout.log').write_text(result.stdout)
        (archive.parent / 'entry-probe.stderr.log').write_text(result.stderr)
        require(result.returncode == 0, 'EXECUTION_PROBE_FAILED')
        receipt = json.loads(result.stdout)
        require(receipt['schema'] == 'bellteam.execution.archive-probe.v1' and receipt['uid'] == 1001
                and receipt['stateCompatibility'] == manifest['runtime']['stateCompatibility']
                and receipt['generations'] == 2 and receipt['assetRead'] is True and receipt['dataUnchanged'] is True
                and receipt['nativeCloses'] == 0 and receipt['realNative'] is False, 'EXECUTION_PROBE_RECEIPT')
        require(not list(data.iterdir()), 'EXECUTION_PROBE_WROTE_DATA')
    finally:
        for directory, _, _ in os.walk(root, topdown=False): os.chmod(directory, 0o700)
        shutil.rmtree(root)
    (archive.parent / 'entry-probe.json').write_text(json.dumps(dict(sourceCommit=manifest['sourceCommit'],
        architecture=arch, receipt=receipt, osExit=result.returncode, cleanup=True,
        signedExchange=False, realSdk=False, hostApplied=False), indent=2)+'\n')


if __name__ == '__main__': main()
