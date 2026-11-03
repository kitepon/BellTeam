#!/usr/bin/env python3
"""Unsigned builtin probe on a dedicated disposable native CI runner only."""
import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from web_gateway_artifact import check_archive, require

APP = Path('/app')
PRIVATE = Path('/run/bellteam-maintenance')
STATE = Path('/srv/bellteam')
HOME = Path('/run/bellteam-server')
ENTRY = Path('/usr/local/libexec/bellteam-members-start')
NODE = Path('/usr/local/bin/node')


def clean_runner():
    require(os.geteuid() == 0, 'MEMBERS_PROBE_ROOT_REQUIRED')
    for path in [APP, PRIVATE, STATE, HOME, ENTRY]:
        require(not path.exists() and not path.is_symlink(), 'MEMBERS_PROBE_REQUIRES_CLEAN_RUNNER')


def create_directory(path, uid, gid, mode, created):
    path.mkdir(); created.append(path)
    os.chown(path, uid, gid); path.chmod(mode)


def create_fixture_file(path, value, created):
    path.write_text(value); created.append(path)
    os.chown(path, 1001, 1001); path.chmod(0o600)


def seed_members_state(created):
    state = STATE / 'state'; create_directory(state, 1001, 1001, 0o700, created)
    bots = state / 'bots'; create_directory(bots, 1001, 1001, 0o700, created)
    create_fixture_file(bots / '.initialized', '', created)
    owner = STATE / 'owner'; create_directory(owner, 1001, 1001, 0o700, created)
    create_fixture_file(owner / 'profile.json', json.dumps(dict(schema='bellteam.owner-profile.v1',
        name='fixture', profile='', avatar='', xUrl='', githubUrl='', links=[])), created)
    create_fixture_file(owner / 'user-rules.md', '', created)


def private_mount_namespace():
    require(os.readlink('/proc/self/ns/mnt') != os.readlink('/proc/1/ns/mnt'),
            'MEMBERS_PROBE_PRIVATE_MOUNT_NAMESPACE_REQUIRED')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('node', type=Path)
    args = parser.parse_args()
    clean_runner()
    archive = args.archive.resolve()
    arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine())
    require(platform.system() == 'Linux' and arch is not None, 'MEMBERS_PROBE_NATIVE_RUNNER_REQUIRED')
    with archive.open('rb') as stream:
        manifest, _ = check_archive(stream, arch=arch, component='members')
    node = args.node.resolve(strict=True)
    require(subprocess.check_output([str(node), '-p', 'process.versions.node.split(".")[0]'], text=True).strip() == '26')
    created = []
    process = None
    node_mounted = False
    try:
        if NODE.exists():
            if subprocess.check_output([str(NODE), '-p', 'process.versions.node.split(".")[0]'], text=True).strip() != '26':
                private_mount_namespace()
                subprocess.run(['/bin/mount', '--bind', str(node), str(NODE)], check=True)
                node_mounted = True
        else:
            shutil.copyfile(node, NODE); created.append(NODE); NODE.chmod(0o755)
        if not ENTRY.parent.exists():
            ENTRY.parent.mkdir(); created.append(ENTRY.parent)
        subprocess.run(['cc', '-O2', '-Wall', '-Wextra', '-Werror', str(ROOT / 'scripts/members-start.c'), '-o', str(ENTRY)], check=True)
        created.append(ENTRY); ENTRY.chmod(0o755)
        with tempfile.TemporaryDirectory(prefix='members-unsigned-probe-') as staging:
            with tarfile.open(archive, 'r:gz') as tar:
                tar.extractall(staging, filter='data')
            created.append(APP)
            shutil.copytree(Path(staging) / 'payload', APP)
        for path in sorted(APP.rglob('*'), reverse=True):
            path.chmod(0o555 if path.is_dir() else 0o444)
        APP.chmod(0o555)
        for path, uid, mode in [(PRIVATE, 0, 0o750), (STATE, 0, 0o755), (HOME, 1001, 0o700)]:
            create_directory(path, uid, 1001, mode, created)
        seed_members_state(created)
        process = subprocess.Popen([str(NODE), str(ROOT / 'scripts/probe-members-runtime.mjs')],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True,
            env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/tmp'})
        try:
            stdout, stderr = process.communicate(timeout=120)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
            (archive.parent / 'entry-probe.stdout.log').write_text(stdout)
            (archive.parent / 'entry-probe.stderr.log').write_text(stderr)
            raise
        (archive.parent / 'entry-probe.stdout.log').write_text(stdout)
        (archive.parent / 'entry-probe.stderr.log').write_text(stderr)
        require(process.returncode == 0, 'MEMBERS_ENTRY_PROBE_FAILED')
        require(json.loads(stdout) == dict(schema='bellteam.members.runtime-probe.v1', ok=True,
                uid=1001, protocolVersion=1, stateCompatibility=manifest['runtime']['stateCompatibility'], childClosed=True), 'MEMBERS_PROBE_RECEIPT_INVALID')
        result = dict(sourceCommit=manifest['sourceCommit'], architecture=manifest['runtime']['arch'],
                      entry=manifest['entry'], unsignedBuiltinOnly=True, installationCreated=False,
                      realAi=False, realSeats=False, realSchedules=False, fixedCEntry=True, processExit=process.returncode)
        (archive.parent / 'entry-probe.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result))
    finally:
        if process is not None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
        if node_mounted:
            subprocess.run(['/bin/umount', str(NODE)], check=True)
        for path in reversed(created):
            if path.is_dir():
                for directory in [path, *[x for x in path.rglob('*') if x.is_dir()]]:
                    directory.chmod(0o700)
                shutil.rmtree(path)
            else:
                path.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
