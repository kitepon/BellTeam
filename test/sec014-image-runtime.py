"""Isolated Linux image tests for the public installer, state recovery and UID boundary."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time

LEGACY_IMAGE = 'ghcr.io/kitepon/bellteam-server@sha256:3d314db3e39959611174dd728c2639b65b4a4f713cc9935c506060e8108edb7d'
LEGACY_SOURCE = 'a424c5467ac203b2304ebf5eb4e6f766e757da56'
LEAVES = ['state', 'rooms', 'owner', 'logs', 'shared/tools/bellteam-settings', 'shared/tools/apns']


def lock_info(text, pid, kind):
    return bool(re.search(r'^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+' + kind + r'\s+' + str(pid) + r'\s', text, re.M))


def snapshot(root):
    # Include metadata so a rejected boot cannot quietly alter the sealed tree.
    return {str(p.relative_to(root)): [p.stat().st_uid, p.stat().st_gid,
            stat.S_IMODE(p.stat().st_mode), p.stat().st_ino, p.stat().st_mtime_ns,
            hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None]
            for p in [root, *sorted(root.rglob('*'))]}


def self_check():
    assert lock_info('lock: 1: FLOCK  ADVISORY  READ  123 00:01:2 0 EOF\n', 123, 'READ')
    assert not lock_info('lock: 1: FLOCK  ADVISORY  WRITE  123 00:01:2 0 EOF\n', 123, 'READ')
    assert not lock_info('lock: 1: FLOCK  ADVISORY  READ  1234 00:01:2 0 EOF\n', 123, 'READ')
    with tempfile.TemporaryDirectory(prefix='sec014-harness-check-') as directory:
        root = Path(directory)
        (root / 'value').write_text('before')
        before = snapshot(root)
        assert snapshot(root) == before
        (root / 'value').write_text('after')
        assert snapshot(root) != before
    print('sec014 image harness self-check passed')


def main():
    if os.geteuid() != 0 or len(sys.argv) != 3 or os.environ.get('SEC014_ISOLATED_CI') != '1':
        raise SystemExit('run as root on the dedicated CI Docker daemon: test IMAGE SOURCE')
    image, source = sys.argv[1:]
    if not re.fullmatch('[a-f0-9]{40}', source) or image != 'bellteam-sec014-test:' + source:
        raise SystemExit('SEC014_TEST_IMAGE_SELECTION')
    base = Path(tempfile.mkdtemp(prefix='sec014-image-', dir=os.environ['RUNNER_TEMP']))
    result = Path(os.environ['RUNNER_TEMP']) / 'sec014-image-result'
    result.mkdir(mode=0o700)
    config = base / 'docker-config'
    config.mkdir(mode=0o700)
    env = dict(PATH='/usr/local/bin:/usr/bin:/bin', HOME='/nonexistent',
               DOCKER_HOST='unix:///var/run/docker.sock', DOCKER_CONFIG=str(config))
    projects, extra_containers, volumes, checks = [], [], set(), []
    command_number = 0

    def run(args, *, cwd=None, environment=None, check=True, timeout=180):
        nonlocal command_number
        reply = subprocess.run(args, cwd=cwd, env=environment or env,
                               capture_output=True, text=True, timeout=timeout)
        command_number += 1
        (result / ('command-%03d.log' % command_number)).write_text(
            json.dumps(dict(args=args, cwd=str(cwd) if cwd else None, exit=reply.returncode))
            + '\n' + reply.stdout + '\n' + reply.stderr)
        if check:
            reply.check_returncode()
        return reply

    def docker(*args, **kwargs):
        return run(['/usr/bin/docker', *map(str, args)], **kwargs)

    def document(name, value):
        path = result / name
        path.write_text(json.dumps(value, indent=2) + '\n')
        path.chmod(0o600)

    def install_directory(name, selected_image, *, existing_runtime=False):
        root = base / name
        root.mkdir(mode=0o700)
        for file in ['compose.yaml', 'install.sh']:
            data = docker('run', '--rm', '--network', 'none', '--read-only', '--entrypoint',
                          '/bin/cat', selected_image, '/app/' + file).stdout
            (root / file).write_text(data)
        if existing_runtime:
            for directory in ['home', 'data']:
                path = root / 'runtime' / directory
                path.mkdir(parents=True)
                os.chown(path, 1000, 1000)
                path.chmod(0o700)
        project = 'sec014-' + base.name.rsplit('-', 1)[-1] + '-' + name
        projects.append(project)
        return root, dict(env, COMPOSE_FILE=str(root / 'compose.yaml'), COMPOSE_PROJECT_NAME=project,
                          BELLTEAM_SERVER_IMAGE=selected_image, BELLTEAM_BIND_IP='127.0.0.1')

    def compose(root, environment, *args, **kwargs):
        return docker('compose', *args, cwd=root, environment=environment, **kwargs)

    def installer(root, environment, *args, **kwargs):
        return run(['/bin/sh', str(root / 'install.sh'), *map(str, args)],
                   cwd=root, environment=environment, **kwargs)

    def current(root, environment):
        ids = compose(root, environment, 'ps', '--all', '--quiet', '--no-trunc', 'bellteam').stdout.split()
        assert len(ids) == 1, ids
        return ids[0]

    def inspect(cid):
        return json.loads(docker('inspect', cid).stdout)[0]

    def saved_generation(root, reply):
        paths = re.findall(r'^saved-compose=(.+)$', reply.stdout, re.M)
        assert len(paths) == 1, reply.stdout
        saved = Path(paths[0])
        assert saved.parent == root and stat.S_IMODE(saved.stat().st_mode) == 0o700
        for name in ['normal.json', 'compose.state-maintenance.json']:
            assert stat.S_IMODE((saved / name).stat().st_mode) == 0o600
        return saved

    def api(cid, path):
        program = "fetch('http://127.0.0.1:4181'+process.argv[1]).then(async r=>{if(r.status!==200)throw Error(r.status);console.log(JSON.stringify(await r.json()))}).catch(e=>{console.error(e.message);process.exitCode=1})"
        return json.loads(docker('exec', cid, '/usr/local/bin/node', '-e', program, path).stdout)

    def health(cid):
        state = inspect(cid)
        assert state['State']['Running'] and state['State']['Health']['Status'] == 'healthy', state['State']
        assert docker('exec', cid, 'curl', '-fsS', 'http://127.0.0.1:4180/healthz').returncode == 0
        return state

    def maintenance(root, environment, saved, direction, **kwargs):
        return compose(root, environment, '--project-directory', str(root), '-f',
                       str(saved / 'compose.state-maintenance.json'), 'run', '--pull', 'never',
                       '--rm', '--no-deps', '-T', 'state-maintenance', direction, **kwargs)

    def stopped(root, environment):
        cid = current(root, environment)
        start = time.monotonic()
        docker('stop', cid)
        value = inspect(cid)
        assert not value['State']['Running'] and value['State']['ExitCode'] == 0
        return cid, time.monotonic() - start

    def remove_project(root, environment):
        # Every model uses the same project/volume. Exact project names are unique to this run.
        compose(root, environment, 'down', '--volumes', '--remove-orphans')

    def rejected_boot(model, candidate, expected=None):
        # Run exactly the previously captured service mounts/env, without its restart loop or ports.
        clone = json.loads(model.read_text())
        service = clone['services']['bellteam']
        service['image'] = candidate
        service['restart'] = 'no'
        service.pop('ports', None)
        service.pop('container_name', None)
        model_path = base / ('reject-%d.json' % len(extra_containers))
        model_path.write_text(json.dumps(clone))
        reply = docker('compose', '-f', model_path, 'run', '--no-deps', '-T', '--name',
                       'sec014-reject-' + base.name + '-' + str(len(extra_containers)),
                       '--pull', 'never', 'bellteam', check=False)
        cid = docker('ps', '-aq', '--no-trunc', '--filter',
                     'name=sec014-reject-' + base.name + '-' + str(len(extra_containers))).stdout.strip()
        assert re.fullmatch('[a-f0-9]{64}', cid), reply.stdout + reply.stderr
        extra_containers.append(cid)
        state = inspect(cid)['State']
        assert not state['Running'] and state['ExitCode'] != 0, state
        if expected is not None:
            assert state['ExitCode'] == expected, state
        docker('rm', cid)
        return state['ExitCode']

    def assert_busy(path, kind):
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            try:
                fcntl.flock(fd, kind | fcntl.LOCK_NB)
            except BlockingIOError:
                return
            raise AssertionError('expected kernel lock conflict: ' + str(path))
        finally:
            os.close(fd)

    def interrupt_maintenance(root, environment, saved, point):
        # Faults are injected into the real filesystem calls inside the test container only.
        marker = root / 'runtime/.harness-paused'
        marker.unlink(missing_ok=True)
        name = 'sec014-fault-' + base.name + '-' + point
        program = r"""import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const root='/srv/bellteam-runtime',point=process.argv[1],original=fs.promises.rename;
let moved=0;
fs.promises.rename=async (source,target)=>{
 await original(source,target);
 if(point==='seal'&&target===root+'/server-only/state-data/.transaction.json'){
  await fs.promises.writeFile(root+'/.harness-paused','seal');
  await new Promise(()=>setInterval(()=>{},1000));
 }
 if(point==='three-roots'&&['state','rooms','owner'].some(n=>source===root+'/server-only/state-data/'+n)&&++moved===3){
  await fs.promises.writeFile(root+'/.harness-paused','three-roots');
  process.kill(process.pid,'SIGKILL');
 }
};
syncBuiltinESMExports();
const {migrateServerState}=await import('/app/src/server-state-transfer.mjs');
await migrateServerState({root,direction:point==='seal'?'to-server':'to-legacy'});
"""
        args = ['/usr/bin/docker', 'compose', '--project-directory', str(root), '-f',
                str(saved / 'compose.state-maintenance.json'), 'run', '--pull', 'never',
                '--no-deps', '-T', '--name', name, '--entrypoint', '/usr/bin/flock',
                'state-maintenance', '-x', '-n', '-E', '75',
                '/srv/bellteam-runtime/server-only/state-data', '/usr/local/bin/node',
                '--input-type=module', '-e', program, point]
        with (result / ('interruption-' + point + '.log')).open('w') as log:
            cli = subprocess.Popen(args, cwd=root, env=environment, stdout=log, stderr=subprocess.STDOUT)
            try:
                until = time.monotonic() + 30
                while not marker.exists() and time.monotonic() < until and cli.poll() is None:
                    time.sleep(.1)
                assert marker.read_text() == point, point
                value = json.loads(docker('inspect', name).stdout)[0]
                extra_containers.append(value['Id'])
                if point == 'seal':
                    assert value['State']['Running']
                    cli.kill()
                    assert cli.wait(timeout=5) < 0
                    assert inspect(value['Id'])['State']['Running'], 'killed Docker CLI must leave maintenance alive'
                    assert maintenance(root, environment, saved, 'prepare', check=False).returncode == 75
                    assert maintenance(root, environment, saved, 'to-server', check=False).returncode == 75
                    docker('kill', value['Id'])
                else:
                    assert cli.wait(timeout=20) != 0
                    assert not inspect(value['Id'])['State']['Running']
                docker('rm', '--force', value['Id'])
            finally:
                if cli.poll() is None:
                    cli.kill()
                    cli.wait(timeout=5)
        marker.unlink()

    try:
        image_id = docker('image', 'inspect', '--format', '{{.Id}}', image).stdout.strip()
        assert re.fullmatch('sha256:[a-f0-9]{64}', image_id)
        actual_source = docker('run', '--rm', '--network', 'none', '--read-only', '--entrypoint',
                               '/usr/local/bin/node', image_id, '-p',
                               'JSON.parse(require("fs").readFileSync("/app/distribution.json")).sourceCommit').stdout.strip()
        assert actual_source == source

        # R3: an interrupted fresh-HOME chown must leave only unpublished staging.
        r3runtime = base / 'r3runtime'
        r3runtime.mkdir(mode=0o700)
        r3args = ['run', '--pull', 'never', '--rm', '--network', 'none', '--read-only',
                  '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'CHOWN',
                  '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER',
                  '--security-opt', 'no-new-privileges:true', '--mount',
                  'type=bind,source=' + str(r3runtime) + ',target=/srv/bellteam-runtime',
                  '--entrypoint', '/usr/local/bin/node', image_id]
        program = r"""import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const root='/srv/bellteam-runtime',original=fs.promises.open;
fs.promises.open=async (...args)=>{
 const file=await original(...args);
 if(args[0]===root+'/server-only/state-data/.new-home')
  file.chown=async ()=>{throw Object.assign(new Error('injected staged HOME interruption'),{code:'EINTR'})};
 return file;
};
syncBuiltinESMExports();
const {prepareServerStateRuntime}=await import('/app/src/server-state-transfer.mjs');
let interrupted=false;
try{await prepareServerStateRuntime({root})}catch(error){if(error.code!=='EINTR')throw error;interrupted=true}
if(!interrupted)throw Error('staged HOME chown was not exercised');
console.log(JSON.stringify({interrupted,code:'EINTR'}));
"""
        interrupted = json.loads(docker(*r3args, '--input-type=module', '-e', program).stdout)
        assert interrupted == dict(interrupted=True, code='EINTR')
        staged = r3runtime / 'server-only/state-data/.new-home'
        assert not (r3runtime / 'home').exists()
        assert (staged.stat().st_uid, stat.S_IMODE(staged.stat().st_mode)) == (0, 0o700)
        resumed_home = json.loads(docker(*r3args, '/app/src/server-state-transfer.mjs', 'prepare').stdout)
        assert resumed_home['status'] == 'prepared'
        home_info = (r3runtime / 'home').stat()
        assert (home_info.st_uid, home_info.st_gid, stat.S_IMODE(home_info.st_mode)) == (1000, 1000, 0o700)
        assert not staged.exists()
        document('r3-home-interruption.json', dict(injected=interrupted, homeUnpublishedAfterInterruption=True,
            stagedUidAfterInterruption=0, resumed=resumed_home, homeUid=home_info.st_uid,
            homeGid=home_info.st_gid, homeMode=oct(stat.S_IMODE(home_info.st_mode)), stagingAbsent=True))
        checks.append('R3 real staged-HOME chown EINTR leaves HOME absent; official prepare resumes to UID1000/0700')

        docker('pull', LEGACY_IMAGE, timeout=300)
        legacy_id = docker('image', 'inspect', '--format', '{{.Id}}', LEGACY_IMAGE).stdout.strip()
        assert docker('run', '--rm', '--network', 'none', '--read-only', '--entrypoint',
                      '/usr/local/bin/node', legacy_id, '-p',
                      'JSON.parse(require("fs").readFileSync("/app/distribution.json")).sourceCommit').stdout.strip() == LEGACY_SOURCE
        document('images.json', dict(candidate=image_id, source=source, legacy=legacy_id,
                                     legacyReference=LEGACY_IMAGE, legacySource=LEGACY_SOURCE))

        root, normal_env = install_directory('fresh', image_id)
        assert {path.name for path in root.iterdir()} == {'compose.yaml', 'install.sh'}
        assert not (root / 'runtime').exists()
        first = saved_generation(root, installer(root, normal_env, '--no-pull'))
        cid = current(root, normal_env)
        value = health(cid)
        assert api(cid, '/api/bots?avatar=omit')['bots'] == []
        for mount in value['Mounts']:
            if mount['Type'] == 'volume':
                volumes.add(mount['Name'])
        private = root / 'runtime/server-only/state-data'
        data = root / 'runtime/data'
        home = root / 'runtime/home'
        assert (home.stat().st_uid, home.stat().st_gid, stat.S_IMODE(home.stat().st_mode)) == (1000, 1000, 0o700)
        home_check = "const fs=require('fs'),assert=require('assert/strict'),p='/home/bell/.harness-write-check';assert.equal(process.getuid(),1000);assert.equal(process.getgid(),1000);fs.writeFileSync(p,'UID1000 home writable',{flag:'wx'});assert.equal(fs.readFileSync(p,'utf8'),'UID1000 home writable');fs.unlinkSync(p);console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),homeWritable:true}))"
        home_result = json.loads(docker('exec', '--user', '1000:1000', cid,
                                        '/usr/local/bin/node', '-e', home_check).stdout)
        assert home_result == dict(uid=1000, gid=1000, homeWritable=True)
        document('fresh-home.json', home_result)
        assert (private.stat().st_uid, private.stat().st_gid, stat.S_IMODE(private.stat().st_mode)) == (0, 1001, 0o750)
        assert (data.stat().st_uid, data.stat().st_gid, stat.S_IMODE(data.stat().st_mode)) == (1000, 1000, 0o711)
        assert not (private / '.transaction.json').exists()
        checks.append('public two-file fresh install from absent runtime; empty boot and real UID1000 HOME write/modes/health')

        # The supervisor itself must own both actual directory inodes and kernel locks.
        top = docker('top', cid, '-eo', 'pid,args').stdout.splitlines()[1:]
        pids = [int(row.split(None, 1)[0]) for row in top
                if row.split(None, 1)[1] == '/usr/local/bin/node /app/src/supervisor.mjs']
        assert len(pids) == 1, top
        pid = pids[0]
        proc = Path('/proc') / str(pid)
        birth = proc.joinpath('stat').read_text().rsplit(') ', 1)[1].split()[19]
        for number, target, kind in [(3, private, 'READ'), (4, private / 'state', 'WRITE')]:
            held = proc.joinpath('fd', str(number)).stat()
            actual = target.stat()
            assert stat.S_ISDIR(held.st_mode) and (held.st_dev, held.st_ino) == (actual.st_dev, actual.st_ino)
            assert lock_info(proc.joinpath('fdinfo', str(number)).read_text(), pid, kind)
        for field in ['Uid', 'Gid']:
            assert re.search(r'^' + field + r':\s+1001\s+1001\s+1001\s+1001$', proc.joinpath('status').read_text(), re.M)
        assert proc.joinpath('stat').read_text().rsplit(') ', 1)[1].split()[19] == birth
        assert_busy(private, fcntl.LOCK_EX)
        assert_busy(private / 'state', fcntl.LOCK_SH)
        assert maintenance(root, normal_env, first, 'prepare', check=False).returncode == 75
        assert maintenance(root, normal_env, first, 'to-server', check=False).returncode == 75
        assert rejected_boot(first / 'normal.json', image_id, 126) == 126
        checks.append('directory FD3 SH and state FD4 EX; live maintenance and second normal refused')

        # Prove both FDs really survive a direct exec without the seat boundary, then close both there.
        stopped(root, normal_env)
        child_program = "const fs=require('fs'),wanted=JSON.parse(process.argv[1]);console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),inherited:wanted.map((v,i)=>{try{const a=fs.fstatSync(i+3);return a.dev===v.dev&&a.ino===v.ino}catch{return false}})}))"
        proof_program = r"""import fcntl,json,os,subprocess,sys
for number,path,kind in [(3,'/run/bellteam-maintenance',fcntl.LOCK_SH),(4,'/srv/bellteam/state',fcntl.LOCK_EX)]:
 fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY)
 if fd!=number:os.dup2(fd,number);os.close(fd)
 os.set_inheritable(number,True);fcntl.flock(number,kind|fcntl.LOCK_NB)
 before=os.fstat(number);wanted=os.stat(path)
 assert (before.st_dev,before.st_ino)==(wanted.st_dev,wanted.st_ino)
control=json.loads(subprocess.check_output(['/usr/local/bin/node','-e',sys.argv[1],sys.argv[2]],pass_fds=(3,4),text=True))
assert control['inherited']==[True,True],control
print(json.dumps({'withoutEntry':control}),flush=True)
os.execv('/usr/local/libexec/bellteam-seat-exec',['/usr/local/libexec/bellteam-seat-exec','--','/usr/local/bin/node','-e',sys.argv[1],sys.argv[2]])
"""
        wanted = [dict(dev=path.stat().st_dev, ino=path.stat().st_ino) for path in [private, private / 'state']]
        proof = docker('compose', '-f', first / 'normal.json', 'run', '--rm', '--no-deps', '-T',
                       '--user', '0:0', '--entrypoint', '/usr/bin/python3', 'bellteam',
                       '-c', proof_program, child_program, json.dumps(wanted))
        rows = [json.loads(line) for line in proof.stdout.splitlines()]
        assert len(rows) == 2 and rows[0]['withoutEntry']['inherited'] == [True, True]
        assert rows[1] == dict(uid=1000, gid=1000, groups=[1000], inherited=[False, False]), rows
        document('seat-fd-proof.json', rows)
        checks.append('installed seat C entry drops to UID1000 and closes proved inherited FD3/FD4')
        # Reenter through the installer, preserving all data and producing a server-layout predecessor.
        (root / 'runtime/home/retained.txt').write_text('HOME retained')
        os.chown(root / 'runtime/home/retained.txt', 1000, 1000)
        second = saved_generation(root, installer(root, normal_env, '--no-pull'))
        cid = current(root, normal_env)
        health(cid)
        assert (root / 'runtime/home/retained.txt').read_text() == 'HOME retained'
        assert json.loads((second / 'previous-normal.json').read_text())['services']['bellteam']['image'] == image_id
        installer(root, normal_env, '--recover', second)
        health(current(root, normal_env))
        assert (root / 'runtime/home/retained.txt').read_text() == 'HOME retained'
        checks.append('public no-op update and explicit server-layout recovery preserve HOME')
        remove_project(root, normal_env)

        # Start the published old generation with its own exact public compose, then overwrite only the two installer files.
        root, legacy_env = install_directory('migration', LEGACY_IMAGE, existing_runtime=True)
        data = root / 'runtime/data'
        for bot in ['bot-a', 'bot-b']:
            project = data / 'bots' / bot
            (project / 'docs').mkdir(parents=True)
            (project / 'bot.json').write_text(json.dumps(dict(schema='bellteam.bot.v8', id=bot,
                name=bot, session=bot, harness='codex', model='', reasoningEffort='', fastMode=False)))
            (project / 'schedule.json').write_text(json.dumps(dict(schema='bellteam.schedule.v1', schedules=[
                dict(id='retained-' + bot, kind='once', at='2099-01-01T00:00:00Z', prompt='never execute', enabled=False)])))
            (project / 'docs/retained.md').write_text('seat-owned ' + bot)
        (data / 'bots/.initialized').write_text('')
        for directory in ['rooms/room-fixture', 'owner', 'state', 'logs', 'shared/tools/bellteam-settings', 'shared/tools/apns']:
            (data / directory).mkdir(parents=True, exist_ok=True)
        (data / 'rooms/room-fixture/retained.txt').write_text('latest room')
        (data / 'owner/profile.json').write_text(json.dumps(dict(schema='bellteam.owner-profile.v1', name='CI retained owner', links=[])))
        for path in [data, *data.rglob('*')]:
            os.chown(path, 1000, 1000)
            path.chmod(0o700 if path.is_dir() else 0o600)
        compose(root, legacy_env, 'up', '-d', '--wait', '--wait-timeout', '120', '--pull', 'never')
        old_cid = current(root, legacy_env)
        old_runtime = health(old_cid)
        assert {bot['id'] for bot in api(old_cid, '/api/bots?avatar=omit')['bots']} == {'bot-a', 'bot-b'}
        for mount in old_runtime['Mounts']:
            if mount['Type'] == 'volume':
                volumes.add(mount['Name'])
        for file in ['compose.yaml', 'install.sh']:
            (root / file).write_text(docker('run', '--rm', '--network', 'none', '--read-only', '--entrypoint',
                                           '/bin/cat', image_id, '/app/' + file).stdout)
        normal_env = dict(legacy_env, BELLTEAM_SERVER_IMAGE=image_id)
        migrated = saved_generation(root, installer(root, normal_env, '--no-pull'))
        cid = current(root, normal_env)
        health(cid)
        assert {bot['id'] for bot in api(cid, '/api/bots?avatar=omit')['bots']} == {'bot-a', 'bot-b'}
        assert api(cid, '/api/owner')['owner']['name'] == 'CI retained owner'
        assert json.loads((migrated / 'previous-runtime.json').read_text())[0]['Id'] == old_cid
        assert json.loads((migrated / 'previous-normal.json').read_text())['services']['bellteam']['image'] == legacy_id
        private = root / 'runtime/server-only/state-data'
        assert (private / 'rooms/room-fixture/retained.txt').read_text() == 'latest room'
        for bot in ['bot-a', 'bot-b']:
            assert json.loads((private / 'state/bots' / bot / 'schedule.json').read_text())['schedules'][0]['id'] == 'retained-' + bot
            assert not (data / 'bots' / bot / 'bot.json').exists()
        checks.append('published legacy image and exact-compose hash capture migrate two bots/schedules/room/owner')

        # New activity must return, not a backup of the old pre-migration bytes.
        stopped(root, normal_env)
        (private / 'rooms/room-fixture/retained.txt').write_text('newest after migration')
        schedule = private / 'state/bots/bot-a/schedule.json'
        value = json.loads(schedule.read_text())
        value['schedules'][0]['name'] = 'newest schedule'
        schedule.write_text(json.dumps(value))
        os.chown(schedule, 1001, 1001)
        installer(root, normal_env, '--recover', migrated)
        cid = current(root, normal_env)
        health(cid)
        assert inspect(cid)['Image'] == legacy_id
        assert {bot['id'] for bot in api(cid, '/api/bots?avatar=omit')['bots']} == {'bot-a', 'bot-b'}
        assert (data / 'rooms/room-fixture/retained.txt').read_text() == 'newest after migration'
        assert json.loads((data / 'bots/bot-a/schedule.json').read_text())['schedules'][0]['name'] == 'newest schedule'
        assert data.stat().st_uid == 1000
        assert docker('start', old_cid, check=False).returncode != 0  # original CID was recreated, not kept as a delayed target
        checks.append('explicit legacy recovery returns latest schedules/room and starts exact old raw image')

        # Return to new layout, induce the real inverse conflict and verify the durable seal against both images.
        forward = saved_generation(root, installer(root, normal_env, '--no-pull'))
        stopped(root, normal_env)
        conflicting = data / 'shared/tools/call-bridge/headers'
        conflicting.parent.mkdir(parents=True, exist_ok=True)
        conflicting.write_text('Synthetic: conflict\n')
        retained_header = private / 'state/call-bridge/headers'
        retained_header.parent.mkdir(parents=True, exist_ok=True)
        retained_header.write_text('Synthetic: current\n')
        failed = installer(root, normal_env, '--recover', forward, check=False)
        assert failed.returncode != 0 and 'SERVER_STATE_TRANSFER_CONFLICT' in failed.stderr + failed.stdout
        assert (data.stat().st_uid, data.stat().st_gid, stat.S_IMODE(data.stat().st_mode)) == (0, 0, 0o700)
        assert (private / '.transaction.json').exists()
        before = snapshot(data), snapshot(private)
        rejected_boot(forward / 'normal.json', image_id)
        rejected_boot(forward / 'previous-normal.json', legacy_id)
        assert (snapshot(data), snapshot(private)) == before
        assert conflicting.read_text() == 'Synthetic: conflict\n'
        # Resolve the deliberate fixture conflict; the product never chooses a winner.
        conflicting.unlink()
        installer(root, normal_env, '--recover', forward)
        health(current(root, normal_env))
        assert (data / 'shared/tools/call-bridge/headers').read_text() == 'Synthetic: current\n'
        checks.append('partial inverse conflict retains both bytes; seal rejects old/new boot; explicit recovery resumes')

        # A disconnected Docker CLI cannot free the still-running maintenance container's EX.
        stopped(root, normal_env)
        interrupt_maintenance(root, normal_env, forward, 'seal')
        assert (data.stat().st_uid, stat.S_IMODE(data.stat().st_mode)) == (0, 0o700)
        assert (private / '.transaction.json').exists()
        resumed = saved_generation(root, installer(root, normal_env, '--no-pull'))
        health(current(root, normal_env))
        assert {bot['id'] for bot in api(current(root, normal_env), '/api/bots?avatar=omit')['bots']} == {'bot-a', 'bot-b'}
        checks.append('killed Docker CLI leaves maintenance EX alive; second maintenance refuses75; restart converges')

        stopped(root, normal_env)
        for name in LEAVES:
            retained = private / name.split('/')[-1] / 'harness-retained.txt'
            retained.write_text('retained ' + name)
            os.chown(retained, 1001, 1001)
            retained.chmod(0o600)
        interrupt_maintenance(root, normal_env, resumed, 'three-roots')
        assert (data.stat().st_uid, stat.S_IMODE(data.stat().st_mode)) == (0, 0o700)
        assert (private / '.transaction.json').exists()
        for name in LEAVES:
            a = data / name / 'harness-retained.txt'
            b = private / name.split('/')[-1] / 'harness-retained.txt'
            assert a.exists() != b.exists(), name
            assert (a if a.exists() else b).read_text() == 'retained ' + name
        assert (data / 'rooms/room-fixture/retained.txt').read_text() == 'newest after migration'
        installer(root, normal_env, '--recover', resumed)
        health(current(root, normal_env))
        assert inspect(current(root, normal_env))['Image'] == legacy_id
        assert (data / 'rooms/room-fixture/retained.txt').read_text() == 'newest after migration'
        assert not (private / '.transaction.json').exists()
        checks.append('SIGKILL after three real leaf renames retains each unit and explicit inverse recovery converges')
        remove_project(root, normal_env)
        document('result.json', dict(source=source, image=image_id, legacyImage=legacy_id,
            checks=checks, normalPid=pid, normalStartTicks=int(birth),
            scope='isolated Linux Docker: public two-file installer, migration/recovery, real UID/directory locks and seat FD boundary; not production or Mac/WSL filesystem acceptance'))
    finally:
        errors = []
        ids = set(extra_containers)
        for project in projects:
            try:
                ids.update(docker('ps', '-aq', '--no-trunc', '--filter',
                                  'label=com.docker.compose.project=' + project).stdout.split())
            except Exception as error:
                errors.append(type(error).__name__)
        for cid in sorted(ids):
            try:
                present = docker('inspect', cid, check=False)
                if present.returncode == 0:
                    logs = docker('logs', cid, check=False)
                    (result / (cid[:12] + '.log')).write_text(logs.stdout + '\n' + logs.stderr)
                    value = json.loads(present.stdout)[0]
                    volumes.update(m['Name'] for m in value['Mounts'] if m['Type'] == 'volume')
                    docker('rm', '--force', cid)
            except Exception as error:
                errors.append(type(error).__name__)
        for volume in sorted(volumes):
            if docker('volume', 'inspect', volume, check=False).returncode == 0:
                try:
                    docker('volume', 'rm', volume)
                except Exception as error:
                    errors.append(type(error).__name__)
        for project in projects:
            try:
                for network in docker('network', 'ls', '-q', '--filter',
                                      'label=com.docker.compose.project=' + project).stdout.split():
                    docker('network', 'rm', network)
            except Exception as error:
                errors.append(type(error).__name__)
        if not errors:
            shutil.rmtree(base)
        document('cleanup.json', dict(projects=projects, containerIds=sorted(ids),
                                     volumes=sorted(volumes), errors=errors))
        if errors:
            raise RuntimeError('SEC014_TEST_CLEANUP_FAILED')


if __name__ == '__main__':
    if sys.argv[1:] == ['--self-check']:
        self_check()
    else:
        main()
