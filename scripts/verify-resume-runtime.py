#!/usr/bin/env python3
"""Finite native-Docker H1 check against a built immutable image; no build/push."""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import shutil
import subprocess
import tempfile
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('image', help='repository@sha256:digest or local sha256:imageID')
    parser.add_argument('output', type=Path, help='new artifact directory')
    args = parser.parse_args()
    if not re.fullmatch(r'(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}', args.image):
        parser.error('immutable image digest required')
    if not shutil.which('docker'):
        parser.error('existing Docker endpoint required')
    args.output.mkdir(parents=True, exist_ok=False)
    prefix = 'h1-runtime-' + uuid.uuid4().hex[:12]
    work = Path(tempfile.mkdtemp(prefix=prefix + '-'))
    work.chmod(0o755)
    runtime = work / 'runtime'; runtime.mkdir()
    saved = work / 'saved'; saved.mkdir()
    staging = work / 'staging'; staging.mkdir()
    guest = Path(__file__).resolve().parents[1] / 'test/helpers/resume-container-boundary.mjs'
    shutil.copyfile(guest, work / 'guest.mjs')
    (work / 'bootstrap.mjs').write_text("throw Error('H1_FIXTURE_BOOTSTRAP_REACHED')\n")
    volumes = [prefix + '-' + suffix for suffix in ['old', 'new', 'private']]
    report = {'image': args.image, 'prefix': prefix, 'checks': [], 'accepted': False,
              'fixtureBoundary': 'real image runtime; bootstrap import replaced by stop sentinel; no native vendor launch'}
    (args.output / 'allocation.json').write_text(json.dumps({'prefix': prefix, 'volumes': volumes,
        'containerLabel': 'bellteam.h1-fixture=' + prefix, 'composeProject': prefix}) + '\n')
    stage = 'start'

    def run(command, data=None, timeout=45, check=True):
        child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 start_new_session=True, cwd=work)
        try:
            stdout, stderr = child.communicate(data, timeout=timeout)
        except BaseException:
            try:
                os.killpg(child.pid, signal.SIGTERM)
                child.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.communicate()
            except ProcessLookupError:
                child.communicate()
            raise
        result = subprocess.CompletedProcess(command, child.returncode, stdout, stderr)
        if check and result.returncode:
            raise RuntimeError(f'{stage}: exit {result.returncode}: {result.stderr[-2000:].decode(errors="replace")}')
        return result

    def docker(*command, **kwargs):
        if command[0] in ['run', 'create']:
            command = (command[0], '--label', 'bellteam.h1-fixture=' + prefix, *command[1:])
        if command[0] == 'run':
            command = (command[0], '--pull', 'never', *command[1:])
        return run(['docker', *command], **kwargs)

    def mounts(state, private=True, readonly=False):
        result = ['--mount', f'type=bind,source={runtime / "home"},target=/home/bell' + (',readonly' if readonly else ''),
                  '--mount', f'type=bind,source={runtime / "data"},target=/srv/bellteam',
                  '--mount', f'type=volume,source={state},target=/srv/bellteam-aiterm,volume-nocopy' + (',readonly' if readonly else ''),
                  '--mount', f'type=bind,source={work / "guest.mjs"},target=/fixture.mjs,readonly']
        if private:
            result += ['--mount', f'type=volume,source={volumes[2]},target=/run/bellteam-maintenance,readonly',
                       '--mount', f'type=volume,source={volumes[2]},target=/srv/bellteam/state,volume-subpath=state,volume-nocopy']
        return result

    def guest_run(mode, uid='1001:1001', state=None):
        result = docker('run', '--rm', '--init', '--network', 'none', '--read-only', '--user', uid,
                        '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m', '-e', 'AITERM_STATE_BASE=/srv/bellteam-aiterm',
                        '-e', 'BELLTEAM_BUGHUB_KEY=synthetic-not-a-secret',
                        *mounts(state or volumes[1]), '--entrypoint', '/usr/local/bin/node',
                        args.image, '/fixture.mjs', mode, timeout=30)
        if result.stdout.strip():
            report['checks'].append({'stage': stage, 'result': json.loads(result.stdout)})

    def boot(name):
        result = docker('run', '--name', name, '--init', '--network', 'none', '--read-only', '--user', '1001:1001',
                        '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m', '--tmpfs', '/run/bellteam-server:uid=1001,gid=1001,mode=0700',
                        '-e', 'AITERM_STATE_BASE=/srv/bellteam-aiterm', '-e', 'BELLTEAM_RESUME_GENERATION=fixture',
                        '-e', 'BELLTEAM_AITERM_STATE_VOLUME=' + volumes[1], *mounts(volumes[1]),
                        '--mount', f'type=bind,source={work / "bootstrap.mjs"},target=/app/src/bootstrap.mjs,readonly',
                        args.image, check=False, timeout=30)
        (args.output / (name.removeprefix(prefix + '-') + '.log')).write_bytes(result.stderr)
        return b'H1_FIXTURE_BOOTSTRAP_REACHED' in result.stderr

    try:
        stage = 'image-binding'
        image = json.loads(docker('image', 'inspect', args.image).stdout)[0]
        report.update(imageId=image['Id'], architecture=image['Architecture'], source=image['Config'].get('Labels', {}).get('org.opencontainers.image.revision'))
        for name in volumes:
            docker('volume', 'create', '--label', f'bellteam.h1-fixture={prefix}', name)
        stage = 'initialize'
        for state in volumes[:2]:
            docker('run', '--rm', '--network', 'none', '--read-only', '--user', '0:0',
                   '--mount', f'type=bind,source={runtime},target=/fixture-runtime',
                   '--mount', f'type=bind,source={work / "guest.mjs"},target=/fixture.mjs,readonly',
                   '--mount', f'type=volume,source={volumes[2]},target=/private,volume-nocopy',
                   '--mount', f'type=volume,source={state},target=/srv/bellteam-aiterm,volume-nocopy',
                   '--entrypoint', '/usr/local/bin/node', args.image, '/fixture.mjs', 'initialize')
        stage = 'seed'
        guest_run('seed', '1000:1000', volumes[0])
        source = prefix + '-source'
        source_id = docker('create', '--name', source, '--restart', 'no', *mounts(volumes[0]),
                           '--entrypoint', '/usr/local/bin/node', args.image, '-e', 'setInterval(()=>{},1000)').stdout.decode().strip()
        docker('start', source); docker('stop', '--time', '2', source)
        inspection = json.loads(docker('inspect', source).stdout)[0]
        assert inspection['State']['Pid'] == 0 and not inspection['State']['Running'] and not inspection['State']['Restarting']
        assert inspection['HostConfig']['RestartPolicy']['Name'] == 'no'
        report['sourceContainer'] = {'id': source_id, 'pid': 0, 'running': False, 'restartPolicy': 'no'}
        for filename in ['compose.aiterm-checkpoint.yaml', 'compose.state-maintenance.json', 'install-resume-state.sh']:
            (work / filename).write_bytes(docker('run', '--rm', '--network', 'none', '--read-only',
                '--entrypoint', '/bin/cat', args.image, '/app/' + filename).stdout)
        env = dict(os.environ, BELLTEAM_SERVER_IMAGE=args.image, BELLTEAM_AITERM_STATE_VOLUME=volumes[0],
                   BELLTEAM_AITERM_CHECKPOINT_HOME=str(runtime / 'home'), BELLTEAM_SERVER_STATE_VOLUME=volumes[2])
        for source_file, destination in [('compose.aiterm-checkpoint.yaml', 'checkpoint.json'), ('compose.state-maintenance.json', 'compose.state-maintenance.json')]:
            config = subprocess.run(['docker', 'compose', '-f', str(work / source_file), 'config', '--format', 'json'],
                cwd=work, env=env, capture_output=True, check=True, timeout=30)
            (saved / destination).write_bytes(config.stdout)
        stage = 'helper-readonly-mounts'
        probe = '''const a=require('node:assert/strict'),f=require('node:fs');
for(const path of ['/srv/bellteam-aiterm','/home/bell']){
const st=f.statSync(path);a.equal(st.uid,1000);a.equal(st.mode&511,448);
a.throws(()=>f.writeFileSync(path+'/h1-readonly-probe','x'),{code:'EROFS'});}
a.equal(f.existsSync('/srv/bellteam-private'),false);
a.equal(process.getuid(),1000);console.log(JSON.stringify({readonlyState:true,readonlyHome:true,uid:1000}))'''
        readonly = docker('compose', '-f', str(saved / 'checkpoint.json'), '-p', prefix, 'run', '--pull', 'never',
                         '--rm', '--no-deps', '-T', '--entrypoint', '/usr/local/bin/node',
                         'aiterm-checkpoint', '-e', probe)
        report['checks'].append({'stage': stage, 'result': json.loads(readonly.stdout)})
        target = {'session_id': 'offline', 'launch_id': 'a' * 32}
        plan = dict(schema='bellteam.resume-generation.v1', generation='fixture', source_container=source_id,
                    source_image=image['Id'], state_volume=volumes[1], source_volume=volumes[0], home=str(runtime / 'home'), targets=[target])
        (saved / 'resume-plan.json').write_text(json.dumps(plan))
        (saved / 'stopped-runtime.json').write_text(json.dumps(report['sourceContainer']))
        stage = 'real-checkpoint-fifo-private'
        shell = '''set -eu
image=$1; saved=$2; staging=$3; project=$4; resume_count=1; resume_generation=fixture
cleanup_capture() {
  for pid in "${resume_producer_pid:-}" "${resume_receiver_pid:-}" "${resume_receipt_pid:-}"; do
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || :; fi
  done
  wait || :
}
trap cleanup_capture EXIT
trap 'exit 143' HUP INT TERM
. ./install-resume-state.sh
resume_capture
'''
        run(['sh', '-c', shell, 'h1-fixture', args.image, str(saved), str(staging), prefix], timeout=90)
        guest_run('private-check')
        stage = 'readonly-source-unchanged'; guest_run('verify', '1000:1000', volumes[0])
        stage = 'uid-private-signal'; guest_run('identity-signal')
        stage = 'prebootstrap'
        assert boot(prefix + '-boot'), 'real supervisor did not reach bootstrap sentinel'
        guest_run('adopted'); guest_run('verify', '1000:1000')
        stage = 'adoption-no-replay'; guest_run('mark', '1000:1000')
        assert boot(prefix + '-restart'), 'adopted boot did not reach bootstrap sentinel'
        guest_run('check-mark', '1000:1000')
        stage = 'failure-stops-bootstrap'; guest_run('damage')
        assert not boot(prefix + '-invalid'), 'invalid checkpoint reached bootstrap'
        assert b'RESUME_CHECKPOINT_CHANGED' in (args.output / 'invalid.log').read_bytes()
        guest_run('rejected')
        report['checks'].append({'stage': stage, 'result': {'bootstrapReached': False}})
        report['accepted'] = True
    except (Exception, KeyboardInterrupt) as error:
        report['failure'] = {'stage': stage, 'error': str(error)}
    finally:
        # Only this invocation's names/project/volumes are eligible for removal.
        cleanup_errors = []
        def clean(*command):
            try:
                result = docker(*command, check=False, timeout=20)
                if result.returncode: cleanup_errors.append(' '.join(command[:2]))
                return result.stdout.decode().split() if result.returncode == 0 else []
            except Exception:
                cleanup_errors.append(' '.join(command[:2])); return []
        remaining = []
        for label in [f'com.docker.compose.project={prefix}', f'bellteam.h1-fixture={prefix}']:
            remaining += clean('ps', '-aq', '--filter', 'label=' + label)
        for name in set(remaining):
            clean('rm', '-f', name)
        clean('run', '--rm', '--network', 'none', '--read-only', '--user', '0:0',
              '--mount', f'type=bind,source={runtime},target=/fixture-runtime',
              '--mount', f'type=bind,source={work / "guest.mjs"},target=/fixture.mjs,readonly',
              '--entrypoint', '/usr/local/bin/node', args.image, '/fixture.mjs', 'cleanup')
        for name in volumes:
            clean('volume', 'rm', name)
        report['cleanupErrors'] = cleanup_errors
        report['accepted'] = report['accepted'] and not cleanup_errors
        (args.output / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
        if not cleanup_errors: shutil.rmtree(work)
    print(json.dumps({'accepted': report['accepted'], 'stage': stage, 'result': str(args.output / 'result.json')}))
    return 0 if report['accepted'] else 1


if __name__ == '__main__':
    def stop(_signal, _frame):
        raise KeyboardInterrupt('runtime fixture cancelled')
    signal.signal(signal.SIGTERM, stop)
    raise SystemExit(main())
