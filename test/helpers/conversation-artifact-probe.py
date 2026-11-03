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
from web_gateway_artifact import check_archive, require, sha256

APP = Path('/app')
PRIVATE = Path('/run/bellteam-maintenance')
STATE = Path('/srv/bellteam')
HOME = Path('/run/bellteam-server')
ENTRY = Path('/usr/local/libexec/bellteam-conversation-start')
NODE = Path('/usr/local/bin/node')


def clean_runner():
    require(os.geteuid() == 0, 'CONVERSATION_PROBE_ROOT_REQUIRED')
    for path in [APP, PRIVATE, STATE, HOME, ENTRY]:
        require(not path.exists() and not path.is_symlink(), 'CONVERSATION_PROBE_REQUIRES_CLEAN_RUNNER')


def create_directory(path, uid, gid, mode, created):
    path.mkdir(); created.append(path)
    os.chown(path, uid, gid); path.chmod(mode)


def create_fixture_file(path, value, created):
    path.write_text(value); created.append(path)
    os.chown(path, 1001, 1001); path.chmod(0o600)


def seed_conversation_state(created):
    path = Path('src/conversation/probe-fixture.json')
    raw = (APP / path).read_bytes()
    require(raw == (ROOT / path).read_bytes(), 'CONVERSATION_PROBE_FIXTURE_SOURCE_MISMATCH')
    fixture = json.loads(raw)
    require(type(fixture) is dict and set(fixture) == {'bots', 'files'}
            and type(fixture['bots']) is list and type(fixture['files']) is dict
            and set(fixture['files']) == {'rooms/room-conversation-probe/room.json',
                'rooms/room-conversation-probe/schedule.json', 'logs/self-turns.json'},
            'CONVERSATION_PROBE_FIXTURE_INVALID')
    for name in ['state', 'rooms', 'rooms/room-conversation-probe', 'logs']:
        create_directory(STATE / name, 1001, 1001, 0o700, created)
    create_fixture_file(STATE / 'state/conversation.lock', '', created)
    for name, value in fixture['files'].items():
        create_fixture_file(STATE / name, json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n', created)


def snapshot_state():
    result = {}
    for path in [STATE, *sorted(STATE.rglob('*'))]:
        info = path.lstat()
        require((path.is_dir() or path.is_file()) and not path.is_symlink(), 'CONVERSATION_PROBE_STATE_INVALID')
        result[path.relative_to(STATE).as_posix()] = dict(mode=info.st_mode, uid=info.st_uid,
            gid=info.st_gid, mtimeNs=info.st_mtime_ns,
            sha256=None if path.is_dir() else sha256(path.read_bytes()))
    return result


def stage_parent_probe():
    directory = APP / 'scripts'
    directory.mkdir(exist_ok=True)
    probe = directory / 'probe-conversation-runtime.mjs'
    shutil.copyfile(ROOT / 'scripts/probe-conversation-runtime.mjs', probe)
    return probe


def private_mount_namespace():
    require(os.readlink('/proc/self/ns/mnt') != os.readlink('/proc/1/ns/mnt'),
            'CONVERSATION_PROBE_PRIVATE_MOUNT_NAMESPACE_REQUIRED')


def validate_probe_receipt(value, state):
    expected = dict(schema='bellteam.conversation.runtime-probe.v1', ok=True,
                    uid=1001, protocolVersion=1, stateCompatibility=state, childClosed=True,
                    nativeAuth=False, externalEffects=0)
    require(json.dumps(value, sort_keys=True) == json.dumps(expected, sort_keys=True),
            'CONVERSATION_PROBE_RECEIPT_INVALID')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('node', type=Path)
    args = parser.parse_args()
    clean_runner()
    archive = args.archive.resolve()
    arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine())
    require(platform.system() == 'Linux' and arch is not None, 'CONVERSATION_PROBE_NATIVE_RUNNER_REQUIRED')
    with archive.open('rb') as stream:
        manifest, _ = check_archive(stream, arch=arch, component='conversation')
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
        subprocess.run(['cc', '-O2', '-Wall', '-Wextra', '-Werror', str(ROOT / 'scripts/conversation-start.c'), '-o', str(ENTRY)], check=True)
        created.append(ENTRY); ENTRY.chmod(0o755)
        with tempfile.TemporaryDirectory(prefix='conversation-unsigned-probe-') as staging:
            with tarfile.open(archive, 'r:gz') as tar:
                tar.extractall(staging, filter='data')
            created.append(APP)
            shutil.copytree(Path(staging) / 'payload', APP)
        probe = stage_parent_probe()
        for path in sorted(APP.rglob('*'), reverse=True):
            path.chmod(0o555 if path.is_dir() else 0o444)
        APP.chmod(0o555)
        for path, uid, mode in [(PRIVATE, 0, 0o750), (STATE, 0, 0o755), (HOME, 1001, 0o700)]:
            create_directory(path, uid, 1001, mode, created)
        seed_conversation_state(created)
        before_state = snapshot_state()
        process = subprocess.Popen([str(NODE), str(probe)],
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
        require(process.returncode == 0, 'CONVERSATION_ENTRY_PROBE_FAILED')
        validate_probe_receipt(json.loads(stdout), manifest['runtime']['stateCompatibility'])
        require(snapshot_state() == before_state, 'CONVERSATION_PROBE_STATE_CHANGED')
        result = dict(sourceCommit=manifest['sourceCommit'], architecture=manifest['runtime']['arch'],
                      entry=manifest['entry'], unsignedBuiltinOnly=True, installationCreated=False,
                      realAi=False, realSeats=False, realSchedules=False, realJev=False, stateUnchanged=True, fixedCEntry=True, processExit=process.returncode)
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
