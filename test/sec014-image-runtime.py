"""Isolated Linux image tests for the public installer, state recovery and UID boundary."""
import ast
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
import threading
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
    # Parse embedded programs too; outer Python compilation cannot catch their indentation.
    for node in ast.walk(ast.parse(Path(__file__).read_text())):
        if not isinstance(node, ast.Assign) or not isinstance(node.value, ast.Constant) or not isinstance(node.value.value, str):
            continue
        names = {target.id for target in node.targets if isinstance(target, ast.Name)}
        if 'proof_program' in names:
            compile(node.value.value, '<embedded proof_program>', 'exec')
        elif names & {'program', 'child_program', 'seat_bughub', 'bughub_program', 'home_check'}:
            subprocess.run([shutil.which('node'), '--input-type=module', '--check'],
                           input=node.value.value, text=True, check=True, capture_output=True)
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

    def run(args, *, cwd=None, environment=None, check=True, timeout=180, input=None):
        nonlocal command_number
        reply = subprocess.run(args, cwd=cwd, env=environment or env,
                               capture_output=True, text=True, timeout=timeout, input=input)
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
        name = variant + '-' + name
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
        volume = project + '-state'
        volumes.add(volume)
        if variant == 'native':
            docker('volume', 'create', '--driver', 'local', '--label',
                   'com.docker.compose.project=' + project, volume)
        return root, dict(env, COMPOSE_FILE=str(root / 'compose.yaml'), COMPOSE_PROJECT_NAME=project,
                          BELLTEAM_SERVER_STATE_VOLUME=volume,
                          BELLTEAM_SERVER_IMAGE=selected_image, BELLTEAM_BIND_IP='127.0.0.1')

    def state_storage(root, environment):
        volume = environment['BELLTEAM_SERVER_STATE_VOLUME']
        record = json.loads(docker('volume', 'inspect', volume).stdout)[0]
        assert record['Name'] == volume and record['Driver'] == 'local'
        assert record['Labels']['com.docker.compose.project'] == environment['COMPOSE_PROJECT_NAME']
        options = record['Options'] or {}
        if variant == 'bind':
            assert options == dict(type='none', o='bind', device=str(root / 'runtime/server-only/state-data'))
            path = Path(options['device'])
        else:
            assert options == {}, options
            path = Path(record['Mountpoint'])
        assert path.is_absolute() and path.is_dir()
        document(variant + '-' + root.name + '-volume.json', record)
        return path

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
        if not cid:
            assert expected is None and reply.returncode != 0, reply.stdout + reply.stderr
            return dict(phase='before-container', exit=reply.returncode)
        assert re.fullmatch('[a-f0-9]{64}', cid), reply.stdout + reply.stderr
        extra_containers.append(cid)
        state = inspect(cid)['State']
        assert not state['Running'] and (state['ExitCode'] != 0 or state['Status'] == 'created'), state
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

    def read_call_directory(folder, uid, *, protected=False):
        entry = (folder / 'bellteam.sock').stat()
        assert stat.S_ISSOCK(entry.st_mode) and (entry.st_uid, entry.st_gid) == (uid, uid)
        if protected:
            parent = folder.stat()
            assert (parent.st_uid, parent.st_gid, stat.S_IMODE(parent.st_mode)) == (1001, 1001, 0o711)
            assert stat.S_IMODE(entry.st_mode) == 0o666
        program = r"""import fs from 'node:fs';
import assert from 'node:assert/strict';
import {request} from 'node:http';
const wanted=JSON.parse(process.argv[1]),protectedPeer=process.argv[2]==='true',socket='/peer/bellteam.sock';
assert.equal(process.getuid(),1000);assert.equal(process.getgid(),1000);
const mount=fs.readFileSync('/proc/self/mountinfo','utf8').split('\n').find(line=>line.split(' ')[4]==='/peer');
assert.ok(mount&&mount.split(' ')[5].split(',').includes('ro'));
const same=()=>{const s=fs.statSync(socket);assert.equal(s.dev,wanted.dev);assert.equal(s.ino,wanted.ino);assert.ok(s.isSocket())};
same();
const reply=await new Promise((resolve,reject)=>{
 const call=request({socketPath:socket,method:'GET',path:'/v0/directory'},response=>{
  let text='';response.setEncoding('utf8').on('data',chunk=>text+=chunk).on('end',()=>{
   try{resolve({status:response.statusCode,body:JSON.parse(text)})}catch(error){reject(error)}
  });
 });
 call.on('error',reject);call.end();
});
assert.equal(reply.status,200);assert.equal(reply.body.schema,'bellteam.call-directory.v1');
assert.deepEqual(reply.body.members.map(member=>member.id).sort(),['bot-a','bot-b']);
assert.throws(()=>fs.writeFileSync('/peer/forbidden','x',{flag:'wx'}),error=>['EACCES','EROFS'].includes(error.code));
assert.throws(()=>fs.unlinkSync(socket),error=>['EACCES','EROFS'].includes(error.code));
if(protectedPeer)assert.throws(()=>fs.readdirSync('/peer'),{code:'EACCES'});
same();
console.log(JSON.stringify({phonebookRead:true,readOnlyMount:true,socketSameInode:true,writeDenied:true,unlinkDenied:true,parentListDenied:protectedPeer}));
"""
        peer_mount = ('type=volume,source=' + state_volume + ',target=/peer,volume-subpath=state/call-bridge-socket,readonly'
                      if protected else 'type=bind,source=' + str(folder) + ',target=/peer,readonly')
        value = json.loads(docker('run', '--pull', 'never', '--rm', '--network', 'none',
            '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges:true', '--mount',
            peer_mount,
            '--entrypoint', '/usr/local/bin/node', image_id, '--input-type=module', '-e', program,
            json.dumps(dict(dev=entry.st_dev, ino=entry.st_ino)), str(protected).lower()).stdout)
        assert value == dict(phonebookRead=True, readOnlyMount=True, socketSameInode=True,
                             writeDenied=True, unlinkDenied=True, parentListDenied=protected)
        after = (folder / 'bellteam.sock').stat()
        assert (after.st_dev, after.st_ino) == (entry.st_dev, entry.st_ino)
        return value

    def sce_supply(root, environment, saved, private):
        assert not (private / 'state/bughub').exists()
        values = dict(headers='x-bughub-security-token: ci-sce-first\n',
                      endpoint='http://sce.invalid/api/security/v1\n')
        for mode, value in values.items():
            reply = maintenance(root, environment, saved, 'install-sce-' + mode, input=value)
            assert not reply.stdout.strip()
        folder = private / 'state/bughub'
        assert (folder.stat().st_uid, folder.stat().st_gid, stat.S_IMODE(folder.stat().st_mode)) == (1001, 1001, 0o711)
        for name, value in values.items():
            info = (folder / name).stat()
            assert (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (1001, 1001, 0o600)
            assert (folder / name).read_text() == value
        for uid in [1000, 1001]:
            program = r"""const fs=require('fs'),assert=require('assert/strict'),uid=process.getuid();
for(const name of ['headers','endpoint']){
 const path='/srv/bellteam/state/bughub/'+name,s=fs.statSync(path);
 assert.equal(s.uid,1001);assert.equal(s.gid,1001);assert.equal(s.mode&0o777,0o600);
 if(uid===1000)assert.throws(()=>fs.readFileSync(path),{code:'EACCES'});
 else assert.ok(fs.readFileSync(path).length>0);
}
console.log(JSON.stringify({uid,files:2,readAllowed:uid===1001}));
"""
            value = json.loads(docker('exec', '--user', str(uid)+':'+str(uid), current(root, environment),
                                      '/usr/local/bin/node', '-e', program).stdout)
            assert value == dict(uid=uid, files=2, readAllowed=uid == 1001)
        document(variant + '-sce-first-supply.json', dict(firstParent=True, files=2,
            parentUid=1001, parentMode='0711', fileMode='0600', seatDenied=True, serverRead=True,
            normalSharedLockCoexisted=True, syntheticOnly=True))

    def sce_busy_before_stdin(root, environment, saved, private):
        descriptor = os.open(private, os.O_RDONLY | os.O_DIRECTORY)
        before = snapshot(private / 'state/bughub')
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            for mode in ['headers', 'endpoint']:
                command = ['/usr/bin/docker', 'compose', '--project-directory', str(root), '-f',
                           str(saved / 'compose.state-maintenance.json'), 'run', '--pull', 'never',
                           '--rm', '--no-deps', '-T', 'state-maintenance', 'install-sce-' + mode]
                child = subprocess.Popen(command, cwd=root, env=environment, stdin=subprocess.PIPE,
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    # Keep stdin open and empty: success here cannot rely on EOF or credential input.
                    assert child.wait(timeout=15) == 75
                    child.stdin.close()
                    output, errors = child.stdout.read(), child.stderr.read()
                    assert not output.strip() and 'SCE_INSTALL_BUSY' in errors
                    document(variant + '-sce-' + mode + '-busy.json', dict(exit=75, stdinWritten=False,
                        stdinOpenUntilExit=True, stdout=output, stderr=errors))
                finally:
                    if child.poll() is None:
                        child.kill(); child.wait(timeout=5)
                    child.stdin.close(); child.stdout.close(); child.stderr.close()
        finally:
            os.close(descriptor)
        assert snapshot(private / 'state/bughub') == before

    def interrupt_maintenance(root, environment, saved, private, point):
        # Inject only into the test container's real copy/lstat/rename calls.
        marker = root / 'runtime/.harness-paused'
        marker.unlink(missing_ok=True)
        name = 'sec014-fault-' + base.name + '-' + variant + '-' + point
        program = r"""import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const root='/srv/bellteam-runtime',privateRoot='/srv/bellteam-private',point=process.argv[1];
const rename=fs.promises.rename,lstat=fs.promises.lstat,copy=fs.promises.copyFile;
let copied=0,sawFile=false,paused=false;
const pause=async()=>{
 if(paused)return;paused=true;await fs.promises.writeFile(root+'/.harness-paused',point);
 if(point==='copy')process.kill(process.pid,'SIGKILL');
 await new Promise(()=>setInterval(()=>{},1000));
};
fs.promises.rename=async (a,b)=>{await rename(a,b);if(point==='record'&&b===privateRoot+'/.transaction.json')await pause()};
fs.promises.copyFile=async (...args)=>{await copy(...args);if(point==='copy'&&++copied===3)await pause()};
fs.promises.lstat=async path=>{
 const info=await lstat(path);
 if(path===root+'/data'){
  if(info.isFile()){sawFile=true;if(point==='seal')await pause()}
  else if(point==='unseal'&&sawFile&&info.isDirectory())await pause();
 }
 return info;
};
syncBuiltinESMExports();
const {migrateServerState}=await import('/app/src/server-state-transfer.mjs');
await migrateServerState({root,privateRoot,direction:'to-server'});
"""
        command = ['/usr/bin/docker', 'compose', '--project-directory', str(root), '-f',
                   str(saved / 'compose.state-maintenance.json'), 'run', '--pull', 'never',
                   '--no-deps', '-T', '--name', name, '--entrypoint', '/usr/bin/flock',
                   'state-maintenance', '-x', '-n', '-E', '75', '/srv/bellteam-private',
                   '/usr/local/bin/node', '--input-type=module', '-e', program, point]
        stop_observer = threading.Event()
        observed = dict(directory=0, file=0, missing=0)
        def observe():
            while not stop_observer.is_set():
                try:
                    mode = (root / 'runtime/data').lstat().st_mode
                    observed['directory' if stat.S_ISDIR(mode) else 'file'] += 1
                except FileNotFoundError:
                    observed['missing'] += 1
                time.sleep(.0005)
        observer = threading.Thread(target=observe)
        observer.start()
        with (result / (variant + '-interruption-' + point + '.log')).open('w') as log:
            cli = subprocess.Popen(command, cwd=root, env=environment, stdout=log, stderr=subprocess.STDOUT)
            try:
                until = time.monotonic() + 60
                while not marker.exists() and time.monotonic() < until and cli.poll() is None:
                    time.sleep(.05)
                assert marker.read_text() == point, point
                value = json.loads(docker('inspect', name).stdout)[0]
                extra_containers.append(value['Id'])
                if point == 'copy':
                    assert cli.wait(timeout=20) != 0
                    assert not inspect(value['Id'])['State']['Running']
                    assert list(private.glob('.incoming-*')), 'copy interruption did not retain staging'
                else:
                    assert value['State']['Running']
                    if point == 'seal':
                        cli.kill(); assert cli.wait(timeout=5) < 0
                        assert inspect(value['Id'])['State']['Running'], 'CLI death released container EX'
                        for direction in ['prepare', 'to-server']:
                            assert maintenance(root, environment, saved, direction, check=False).returncode == 75
                    docker('kill', value['Id'])
                    if cli.poll() is None:
                        assert cli.wait(timeout=15) != 0
                docker('rm', '--force', value['Id'])
            finally:
                stop_observer.set(); observer.join(timeout=5)
                if cli.poll() is None:
                    cli.kill(); cli.wait(timeout=5)
        assert observed['missing'] == 0, observed
        assert (private / '.transaction.json').exists()
        if point in ['seal', 'copy']:
            assert (root / 'runtime/data').is_file() and (root / 'runtime/server-only/data').is_dir()
            assert observed['directory'] and observed['file'], observed
        else:
            assert (root / 'runtime/data').is_dir()
        document(variant + '-' + point + '-interruption.json', dict(point=point, record=True,
            observer=observed, dataType='file' if (root / 'runtime/data').is_file() else 'directory'))
        marker.unlink()

    try:
        sce = run(['/usr/bin/python3', '-I', str(Path(__file__).parent / 'sce-headers-installer.py')])
        sce_summary = re.search(r'^Ran (\d+) tests? in ', sce.stderr, re.M)
        assert sce_summary and int(sce_summary[1]) > 0
        assert re.search(r'\nOK\s*$', sce.stderr) and not re.search(r'\bskipped\b', sce.stderr)
        assert re.search(r'^test_root_owner_install_and_real_uid_read_boundaries.* \.\.\. ok$', sce.stderr, re.M)
        document('sce-installer-root.json', dict(realUid=os.getuid(), tests=int(sce_summary[1]),
            skipped=0, syntheticOnly=True, rootReadBoundaryPassed=True,
            scope='source unittest under actual root; not proof of production SCE supply configuration'))

        image_id = docker('image', 'inspect', '--format', '{{.Id}}', image).stdout.strip()
        assert re.fullmatch('sha256:[a-f0-9]{64}', image_id)
        actual_source = docker('run', '--rm', '--network', 'none', '--read-only', '--entrypoint',
                               '/usr/local/bin/node', image_id, '-p',
                               'JSON.parse(require("fs").readFileSync("/app/distribution.json")).sourceCommit').stdout.strip()
        assert actual_source == source

        # R3: an interrupted fresh-HOME chown must leave only unpublished staging.
        r3runtime = base / 'r3runtime'
        r3runtime.mkdir(mode=0o700)
        r3volume = base.name + '-home-state'
        docker('volume', 'create', '--driver', 'local', r3volume)
        volumes.add(r3volume)
        r3args = ['run', '--pull', 'never', '--rm', '--network', 'none', '--read-only',
                  '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'CHOWN',
                  '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER',
                  '--security-opt', 'no-new-privileges:true', '--mount',
                  'type=bind,source=' + str(r3runtime) + ',target=/srv/bellteam-runtime',
                  '--mount', 'type=volume,source=' + r3volume + ',target=/srv/bellteam-private',
                  '--entrypoint', '/usr/local/bin/node', image_id]
        program = r"""import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const root='/srv/bellteam-runtime',original=fs.promises.open;
fs.promises.open=async (...args)=>{
 const file=await original(...args);
 if(args[0]===root+'/server-only/.new-home')
  file.chown=async ()=>{throw Object.assign(new Error('injected staged HOME interruption'),{code:'EINTR'})};
 return file;
};
syncBuiltinESMExports();
const {prepareServerStateRuntime}=await import('/app/src/server-state-transfer.mjs');
let interrupted=false;
try{await prepareServerStateRuntime({root,privateRoot:'/srv/bellteam-private'})}catch(error){if(error.code!=='EINTR')throw error;interrupted=true}
if(!interrupted)throw Error('staged HOME chown was not exercised');
console.log(JSON.stringify({interrupted,code:'EINTR'}));
"""
        interrupted = json.loads(docker(*r3args, '--input-type=module', '-e', program).stdout)
        assert interrupted == dict(interrupted=True, code='EINTR')
        staged = r3runtime / 'server-only/.new-home'
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

        # Unsupported exchange must refuse before publishing a transaction or changing legacy data.
        (r3runtime / 'data/state').mkdir(parents=True)
        (r3runtime / 'data/state/current.txt').write_text('unchanged legacy bytes')
        before_exchange = snapshot(r3runtime / 'data')
        program = r"""import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
cp.execFile=(...args)=>args.at(-1)(Object.assign(Error('unsupported exchange'),{code:'ENOTSUP'}));
syncBuiltinESMExports();
const {migrateServerState}=await import('/app/src/server-state-transfer.mjs');
try {await migrateServerState({root:'/srv/bellteam-runtime',privateRoot:'/srv/bellteam-private',direction:'to-server'});throw Error('accepted unsupported exchange')}
catch(error){if(error.code!=='SERVER_STATE_EXCHANGE_UNSUPPORTED')throw error;console.log(JSON.stringify({code:error.code,dataUnchanged:true}))}
"""
        exchange_refusal = json.loads(docker(*r3args, '--input-type=module', '-e', program).stdout)
        assert snapshot(r3runtime / 'data') == before_exchange
        assert docker('run', '--rm', '--network', 'none', '--read-only', '--mount',
                      'type=volume,source=' + r3volume + ',target=/v,readonly', '--entrypoint',
                      '/usr/bin/test', image_id, '!', '-e', '/v/.transaction.json').returncode == 0
        document('exchange-unsupported.json', exchange_refusal)
        checks.append('unsupported atomic exchange refuses before data mutation or transaction publication')

        docker('pull', LEGACY_IMAGE, timeout=300)
        legacy_id = docker('image', 'inspect', '--format', '{{.Id}}', LEGACY_IMAGE).stdout.strip()
        assert docker('run', '--rm', '--network', 'none', '--read-only', '--entrypoint',
                      '/usr/local/bin/node', legacy_id, '-p',
                      'JSON.parse(require("fs").readFileSync("/app/distribution.json")).sourceCommit').stdout.strip() == LEGACY_SOURCE
        document('images.json', dict(candidate=image_id, source=source, legacy=legacy_id,
                                     legacyReference=LEGACY_IMAGE, legacySource=LEGACY_SOURCE))

        variant_results = []
        for variant in ['bind', 'native']:
            check_start = len(checks)
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
            private = state_storage(root, normal_env)
            state_volume = normal_env['BELLTEAM_SERVER_STATE_VOLUME']
            data = root / 'runtime/data'
            home = root / 'runtime/home'
            assert (home.stat().st_uid, home.stat().st_gid, stat.S_IMODE(home.stat().st_mode)) == (1000, 1000, 0o700)
            home_check = "const fs=require('fs'),assert=require('assert/strict'),p='/home/bell/.harness-write-check';assert.equal(process.getuid(),1000);assert.equal(process.getgid(),1000);fs.writeFileSync(p,'UID1000 home writable',{flag:'wx'});assert.equal(fs.readFileSync(p,'utf8'),'UID1000 home writable');fs.unlinkSync(p);console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),homeWritable:true}))"
            home_result = json.loads(docker('exec', '--user', '1000:1000', cid,
                                            '/usr/local/bin/node', '-e', home_check).stdout)
            assert home_result == dict(uid=1000, gid=1000, homeWritable=True)
            document(variant + '-fresh-home.json', home_result)
            assert (private.stat().st_uid, private.stat().st_gid, stat.S_IMODE(private.stat().st_mode)) == (0, 1001, 0o750)
            assert (data.stat().st_uid, data.stat().st_gid, stat.S_IMODE(data.stat().st_mode)) == (1000, 1000, 0o711)
            assert not (private / '.transaction.json').exists()
            checks.append('public two-file fresh install from absent runtime; empty boot and real UID1000 HOME write/modes/health')
            sce_supply(root, normal_env, first, private)
            checks.append('fixed SCE headers/endpoint first supply coexists with normal SH; server reads and seat denied')

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
            sce_busy_before_stdin(root, normal_env, first, private)
            record = private / '.transaction.json'
            record.write_text('{}')
            before_record = snapshot(private)
            assert rejected_boot(first / 'normal.json', image_id, 126) == 126
            assert snapshot(private) == before_record
            record.unlink()
            checks.append('C entry refuses independent transaction record despite complete normal subpaths; SCE EX refuses before stdin')
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
            document(variant + '-seat-fd-proof.json', rows)
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
            assert state_storage(root, normal_env) == private
            assert (root / 'runtime/home/retained.txt').read_text() == 'HOME retained'
            checks.append('public no-op update and explicit server-layout recovery preserve HOME')
            remove_project(root, normal_env)

            # Start the published old generation with its own exact public compose, then overwrite only the two installer files.
            root, legacy_env = install_directory('migration', LEGACY_IMAGE, existing_runtime=True)
            legacy_env['BELLTEAM_CALL_BRIDGE_MCP_URL'] = 'http://synthetic.invalid/mcp'
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
            for directory in ['rooms/room-fixture', 'owner', 'state', 'logs', 'shared/tools/bellteam-settings', 'shared/tools/apns', 'shared/tools/bughub', 'shared/tools/call-bridge']:
                (data / directory).mkdir(parents=True, exist_ok=True)
            for name in LEAVES:
                (data / name / 'harness-retained.txt').write_text('retained ' + name)
            (data / 'rooms/room-fixture/retained.txt').write_text('latest room')
            (data / 'owner/profile.json').write_text(json.dumps(dict(schema='bellteam.owner-profile.v1', name='CI retained owner', links=[])))
            bughub_initial = dict(endpoint='http://bughub.invalid/api/security/v1\n',
                headers='x-bughub-security-token: ci-dummy-initial\nx-bughub-actor: bot-forged\n')
            bughub_latest = dict(endpoint='http://bughub-hotload.invalid/api/security/v1\n',
                headers='x-bughub-security-token: ci-dummy-latest\n')
            for name, text in bughub_initial.items():
                (data / 'shared/tools/bughub' / name).write_text(text)
            (data / 'shared/tools/call-bridge/headers').write_text('Authorization: Bearer ci-dummy-bridge-token\n')
            for path in [data, *data.rglob('*')]:
                os.chown(path, 1000, 1000)
                path.chmod(0o700 if path.is_dir() else 0o600)
            (data / 'shared/tools/bughub').chmod(0o755)
            (data / 'shared/tools/bughub/endpoint').chmod(0o644)
            compose(root, legacy_env, 'up', '-d', '--wait', '--wait-timeout', '120', '--pull', 'never')
            old_cid = current(root, legacy_env)
            old_runtime = health(old_cid)
            assert {bot['id'] for bot in api(old_cid, '/api/bots?avatar=omit')['bots']} == {'bot-a', 'bot-b'}
            assert json.loads((data / 'shared/tools/bellteam-settings/settings.json').read_text())['callBridge']['enabled'] is True
            bridge_result = dict(legacy=read_call_directory(data / 'shared/tools/call-bridge', 1000))
            for mount in old_runtime['Mounts']:
                if mount['Type'] == 'volume':
                    volumes.add(mount['Name'])
            for file in ['compose.yaml', 'install.sh']:
                (root / file).write_text(docker('run', '--rm', '--network', 'none', '--read-only', '--entrypoint',
                                               '/bin/cat', image_id, '/app/' + file).stdout)
            normal_env = dict(legacy_env, BELLTEAM_SERVER_IMAGE=image_id)
            # Both implementations start migration with the same empty destination leaf.
            if variant == 'bind':
                empty_backing = root / 'runtime/server-only/state-data'
                empty_backing.mkdir(parents=True)
            else:
                empty_backing = Path(json.loads(docker('volume', 'inspect', normal_env['BELLTEAM_SERVER_STATE_VOLUME']).stdout)[0]['Mountpoint'])
            (empty_backing / 'rooms').mkdir()
            migrated = saved_generation(root, installer(root, normal_env, '--no-pull'))
            assert docker('inspect', old_cid, check=False).returncode != 0
            cid = current(root, normal_env)
            health(cid)
            assert {bot['id'] for bot in api(cid, '/api/bots?avatar=omit')['bots']} == {'bot-a', 'bot-b'}
            assert api(cid, '/api/owner')['owner']['name'] == 'CI retained owner'
            assert json.loads((migrated / 'previous-runtime.json').read_text())[0]['Id'] == old_cid
            assert json.loads((migrated / 'previous-normal.json').read_text())['services']['bellteam']['image'] == legacy_id
            private = state_storage(root, normal_env)
            state_volume = normal_env['BELLTEAM_SERVER_STATE_VOLUME']
            assert json.loads((private / 'bellteam-settings/settings.json').read_text())['callBridge']['enabled'] is True
            bridge_result['migrated'] = read_call_directory(private / 'state/call-bridge-socket', 1001, protected=True)
            assert (private / 'rooms/room-fixture/retained.txt').read_text() == 'latest room'
            for name in LEAVES:
                leaf = name.split('/')[-1]
                assert (private / leaf / 'harness-retained.txt').read_text() == 'retained ' + name
                retired = list((root / 'runtime/server-only/retired').glob('*/' + leaf + '/harness-retained.txt'))
                assert len(retired) == 1 and retired[0].read_text() == 'retained ' + name
            for bot in ['bot-a', 'bot-b']:
                assert json.loads((private / 'state/bots' / bot / 'schedule.json').read_text())['schedules'][0]['id'] == 'retained-' + bot
                assert not (data / 'bots' / bot / 'bot.json').exists()
            checks.append('published legacy image and exact-compose hash capture migrate two bots/schedules/room/owner')

            bughub = private / 'state/bughub'
            assert (bughub.stat().st_uid, bughub.stat().st_gid, stat.S_IMODE(bughub.stat().st_mode)) == (1001, 1001, 0o711)
            for name, text in bughub_initial.items():
                info = (bughub / name).stat()
                assert (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (1001, 1001, 0o600)
                assert (bughub / name).read_text() == text
                assert not (data / 'shared/tools/bughub' / name).exists()
            seat_bughub = r"""const fs=require('fs'),assert=require('assert/strict');
    assert.equal(process.getuid(),1000);assert.equal(process.getgid(),1000);
    const directory=fs.statSync('/srv/bellteam/state/bughub');
    assert.equal(directory.mode&0o777,0o711);
    for(const name of ['endpoint','headers']){
     const metadata=fs.statSync('/srv/bellteam/state/bughub/'+name);
     assert.equal(metadata.uid,1001);assert.equal(metadata.gid,1001);assert.equal(metadata.mode&0o777,0o600);
    }
    assert.throws(()=>fs.readFileSync('/srv/bellteam/state/bughub/headers'),{code:'EACCES'});
    assert.throws(()=>fs.writeFileSync('/srv/bellteam/state/bughub/endpoint','unreachable',{flag:'r+'}),{code:'EACCES'});
    console.log(JSON.stringify({metadataReadable:true,headerReadDenied:true,endpointWriteDenied:true}));
    """
            seat_result = json.loads(docker('exec', '--user', '1000:1000', cid,
                                            '/usr/local/bin/node', '-e', seat_bughub).stdout)
            assert seat_result == dict(metadataReadable=True, headerReadDenied=True, endpointWriteDenied=True)
            bughub_program = r"""import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {createBugHubSecurity} from '/app/src/bughub-security.mjs';
assert.equal(process.getuid(),1001);assert.equal(process.getgid(),1001);
globalThis.fetch=()=>{throw Error('unexpected network request')};
let calls=0;
const call=createBugHubSecurity({root:'/srv/bellteam',request:async (url,options)=>{
 const updated=calls++===1;
 assert.equal(url,(updated?'http://bughub-hotload.invalid':'http://bughub.invalid')+'/api/security/v1/findings');
 assert.equal(options.headers['x-bughub-security-token'],updated?'ci-dummy-latest':'ci-dummy-initial');
 assert.equal(options.headers['x-bughub-actor'],updated?'bot-0000000b':'bot-0000000a');
 return new Response(JSON.stringify({findings:[]}),{status:200});
}});
await call({name:'bughub_list_security_findings',args:{},from:'bot-0000000a'});
const server=createServer(socket=>socket.end());
await new Promise(resolve=>server.listen('/srv/bellteam/state/harness-hotload.sock',resolve));
console.log('ready-for-rotation');
await new Promise((resolve,reject)=>server.on('connection',()=>{
 void call({name:'bughub_list_security_findings',args:{},from:'bot-0000000b'}).then(resolve,reject);
}));
await new Promise(resolve=>server.close(resolve));
assert.equal(calls,2);
console.log(JSON.stringify({newPathRead:true,oldPathIgnored:true,hotload:true,actorFixed:true,requestStubOnly:true}));
"""
            stale_bughub = data / 'shared/tools/bughub'
            stale_pair = dict(endpoint='http://stale-bughub.invalid/api/security/v1\n',
                              headers='x-bughub-security-token: ci-dummy-stale\n')
            try:
                for name, text in stale_pair.items():
                    with (stale_bughub / name).open('x') as file:
                        file.write(text)
                    (stale_bughub / name).chmod(0o644)
                consumer_name = 'sec014-consumer-' + base.name + '-' + variant
                consumer = docker('run', '--detach', '--pull', 'never', '--network', 'none',
                    '--name', consumer_name,
                    '--read-only', '--user', '1001:1001', '--cap-drop', 'ALL',
                    '--security-opt', 'no-new-privileges:true', '--mount',
                    'type=bind,source=' + str(data) + ',target=/srv/bellteam,readonly', '--mount',
                    'type=volume,source=' + state_volume + ',target=/srv/bellteam/state,volume-subpath=state',
                    '--entrypoint', '/usr/local/bin/node', image_id, '--input-type=module', '-e', bughub_program).stdout.strip()
                extra_containers.append(consumer)
                deadline = time.monotonic() + 30
                while 'ready-for-rotation' not in docker('logs', consumer).stdout:
                    assert inspect(consumer)['State']['Running'] and time.monotonic() < deadline
                    time.sleep(.1)
                for mode, value in bughub_latest.items():
                    maintenance(root, normal_env, migrated, 'install-sce-' + mode, input=value)
                # Keep the trigger outside the consumer PID namespace: consumer exit must not kill it.
                docker('run', '--rm', '--network', 'none', '--read-only', '--user', '1001:1001',
                       '--mount', 'type=volume,source=' + state_volume + ',target=/srv/bellteam/state,volume-subpath=state,readonly',
                       '--entrypoint', '/usr/local/bin/node', image_id, '-e',
                       "require('net').connect('/srv/bellteam/state/harness-hotload.sock').on('error',e=>{throw e})")
                assert docker('wait', consumer).stdout.strip() == '0'
                bughub_result = json.loads(docker('logs', consumer).stdout.splitlines()[-1])
                docker('rm', consumer)
            finally:
                for name, text in stale_pair.items():
                    path = stale_bughub / name
                    if path.exists() and path.read_text() == text:
                        path.unlink()
            assert all(not (stale_bughub / name).exists() for name in stale_pair)
            assert bughub_result == dict(newPathRead=True, oldPathIgnored=True, hotload=True, actorFixed=True, requestStubOnly=True)
            bughub_result.update(seat_result, protectedFileMetadata=True, oldFilesAbsent=True)
            checks.append('BugHub dummy configuration moves to UID1001/0600 private state; seat reads/writes denied and real consumer hotloads with fixed actor')

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
            bridge_result['legacyRecovery'] = read_call_directory(data / 'shared/tools/call-bridge', 1000)
            for name, text in bughub_latest.items():
                path = data / 'shared/tools/bughub' / name
                info = path.stat()
                assert path.read_text() == text
                assert (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (1000, 1000, 0o600)
                assert not (private / 'state/bughub' / name).exists()
            assert docker('start', old_cid, check=False).returncode != 0  # original CID was recreated, not kept as a delayed target
            checks.append('explicit legacy recovery returns latest schedules/room and starts exact old raw image')

            # Return to new layout, induce the real inverse conflict and verify the durable seal against both images.
            forward = saved_generation(root, installer(root, normal_env, '--no-pull'))
            for name, text in bughub_latest.items():
                assert (private / 'state/bughub' / name).read_text() == text
            stopped(root, normal_env)
            conflicting = data / 'shared/tools/bughub/endpoint'
            conflicting.parent.mkdir(parents=True, exist_ok=True)
            conflicting.write_text('http://conflicting-bughub.invalid/api/security/v1\n')
            failed = installer(root, normal_env, '--recover', forward, check=False)
            assert failed.returncode != 0 and 'SERVER_STATE_TRANSFER_CONFLICT' in failed.stderr + failed.stdout
            assert data.is_file() and (root / 'runtime/server-only/data').is_dir()
            assert (private / '.transaction.json').exists()
            hidden = root / 'runtime/server-only/data'
            conflicting = hidden / 'shared/tools/bughub/endpoint'
            before = snapshot(data), snapshot(private), snapshot(hidden)
            rejected_boot(forward / 'normal.json', image_id)
            rejected_boot(forward / 'previous-normal.json', legacy_id)
            assert (snapshot(data), snapshot(private), snapshot(hidden)) == before
            assert conflicting.read_text() == 'http://conflicting-bughub.invalid/api/security/v1\n'
            # Resolve the deliberate fixture conflict; the product never chooses a winner.
            conflicting.unlink()
            installer(root, normal_env, '--recover', forward)
            health(current(root, normal_env))
            for name, text in bughub_latest.items():
                assert (data / 'shared/tools/bughub' / name).read_text() == text
            checks.append('partial inverse conflict retains both bytes; seal rejects old/new boot; explicit recovery resumes')

            # Every interruption starts from current legacy bytes, then resumes via the public installer.
            for point in ['record', 'seal', 'copy', 'unseal']:
                stopped(root, normal_env)
                for name in LEAVES:
                    retained = data / name / 'harness-retained.txt'
                    assert retained.read_text() == 'retained ' + name
                interrupt_maintenance(root, normal_env, forward, private, point)
                resumed = saved_generation(root, installer(root, normal_env, '--no-pull'))
                health(current(root, normal_env))
                assert {bot['id'] for bot in api(current(root, normal_env), '/api/bots?avatar=omit')['bots']} == {'bot-a', 'bot-b'}
                assert not list(private.glob('.incoming-*'))
                assert not (private / '.transaction.json').exists()
                assert not (root / 'runtime/server-only/data').exists()
                for name in LEAVES:
                    assert (private / name.split('/')[-1] / 'harness-retained.txt').read_text() == 'retained ' + name
                for name, text in bughub_latest.items():
                    assert (private / 'state/bughub' / name).read_text() == text
                installer(root, normal_env, '--recover', resumed)
                health(current(root, normal_env))
                assert inspect(current(root, normal_env))['Image'] == legacy_id
                assert (data / 'rooms/room-fixture/retained.txt').read_text() == 'newest after migration'
                assert not (private / '.transaction.json').exists()
                for name, text in bughub_latest.items():
                    path = data / 'shared/tools/bughub' / name
                    info = path.stat()
                    assert path.read_text() == text
                    assert (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (1000, 1000, 0o600)
            bughub_result.update(latestLegacyBytesRetained=True, legacyUidModeRetained=True,
                                 forwardAndInterruptedRecoveryRetained=True)
            document(variant + '-bughub-boundary.json', bughub_result)
            checks.append('record/seal/copy/unseal SIGKILL resumes current bytes; CLI death keeps EX; atomic exchange never removes data path')

            # Killed listeners leave a real Unix socket; the installer and new listener must accept that restart.
            saved_generation(root, installer(root, normal_env, '--no-pull'))
            cid = current(root, normal_env)
            health(cid)
            read_call_directory(private / 'state/call-bridge-socket', 1001, protected=True)
            docker('update', '--restart', 'no', cid)
            docker('kill', '--signal', 'KILL', cid)
            assert not inspect(cid)['State']['Running']
            assert (private / 'state/call-bridge-socket/bellteam.sock').is_socket()
            saved_generation(root, installer(root, normal_env, '--no-pull'))
            health(current(root, normal_env))
            bridge_result['staleSocketRestart'] = read_call_directory(private / 'state/call-bridge-socket', 1001, protected=True)
            document(variant + '-call-bridge-peer.json', bridge_result)
            checks.append('enabled call-bridge real listener uses private UID1001 socket; UID1000 RO peer reads directory without listing/unlink/write; legacy recovery and stale socket restart work')
            remove_project(root, normal_env)
            variant_results.append(dict(storage=variant, checks=checks[check_start:]))
        document('result.json', dict(source=source, image=image_id, legacyImage=legacy_id,
            checks=checks, variants=variant_results, normalPid=pid, normalStartTicks=int(birth),
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
