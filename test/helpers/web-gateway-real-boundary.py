#!/usr/bin/env python3
"""Finite pull-only native fixture. Never build images or generate attestations."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import subprocess
import tempfile
import time
import uuid
import zipfile

SOURCE = 'a1fe23af75af94cee236cb09b10fcd3304fc36f9'
A_SOURCE = '9573ae0c98d0e781905c814fa4c181880e210f70'
A_RUN = 41545179742
IMAGE_RUN = 41548170408
REPO = Path(__file__).resolve().parents[2]
PARTS = ['state', 'rooms', 'owner', 'logs', 'shared/tools/bellteam-settings', 'shared/tools/apns']
DIGEST = r'sha256:[a-f0-9]{64}'


def execute(command, *, cwd=None, timeout=180, check=True):
    child = subprocess.Popen(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        stdout, stderr = child.communicate(timeout=timeout)
    except BaseException:
        os.killpg(child.pid, signal.SIGTERM)
        try: child.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL); child.communicate()
        raise
    result = subprocess.CompletedProcess(command, child.returncode, stdout, stderr)
    if check and result.returncode:
        raise RuntimeError(f'{command[0]} exit={result.returncode}: {stderr[-2000:].decode(errors="replace")}')
    return result


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def compare_inspections(before, after, output):
    save(output / 'container-after.json', after)
    def normalize(value):
        result = dict(value)
        for field, key in [('mounts', 'Destination'), ('specMounts', 'Target')]:
            targets = [item.get(key) for item in value[field]]
            if not all(isinstance(t, str) and t.startswith('/') for t in targets) or len(set(targets)) != len(targets):
                raise ValueError('invalid or duplicate target in ' + field)
            result[field] = sorted(value[field], key=lambda item: item[key])
        return result
    left, right = normalize(before), normalize(after)
    differences = sorted(key for key in left.keys() | right.keys() if key not in left or key not in right or left[key] != right[key])
    if differences: raise AssertionError('container inspection changed: ' + ', '.join(differences))


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def api(path):
    return execute(['gh', 'api', 'repos/kitepon/BellTeam/' + path]).stdout


def extract_artifact(run, name, output):
    listing = json.loads(api(f'actions/runs/{run}/artifacts'))
    matches = [a for a in listing['artifacts'] if a['name'] == name]
    assert len(matches) == 1 and not matches[0]['expired']
    record = matches[0]; raw = api(f"actions/artifacts/{record['id']}/zip")
    assert record['digest'] == 'sha256:' + sha(raw) and record['size_in_bytes'] == len(raw)
    output.mkdir(); (output / 'artifact.zip').write_bytes(raw); save(output / 'api.json', record)
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        assert archive.testzip() is None and len(archive.infolist()) <= 8
        for item in archive.infolist():
            assert re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]*', item.filename)
            assert not item.is_dir() and item.file_size <= 512 * 1024**2
            assert item.filename not in ['api.json', 'artifact.zip']
            with archive.open(item) as src, (output / item.filename).open('xb') as target:
                shutil.copyfileobj(src, target)
    return record


def fetch_inputs(b_run, digest, output):
    assert re.fullmatch(DIGEST, digest) and b_run > 0 and b_run not in [A_RUN, IMAGE_RUN]
    arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}[platform.machine()]
    output.mkdir(parents=True, exist_ok=False)
    inputs = {}
    for key, run, source, workflow in [('a', A_RUN, A_SOURCE, 'publish-web-gateway.yml'),
            ('b', b_run, SOURCE, 'publish-web-gateway.yml'), ('image', IMAGE_RUN, SOURCE, 'publish-server-image.yml')]:
        r = json.loads(api(f'actions/runs/{run}'))
        assert r['head_sha'] == source and r['run_attempt'] == 1 and r['conclusion'] == 'success'
        assert r['repository']['id'] == 1404510084 and r['path'] == '.github/workflows/' + workflow
        assert r['event'] == ('push' if key == 'image' else 'workflow_dispatch')
        save(output / (key + '-run.json'), r)
        directory = output / key
        extract_artifact(run, 'server-image-index-1' if key == 'image' else f'web-gateway-{arch}-1', directory)
        if key == 'image':
            assert sha((directory / 'index.json').read_bytes()) == digest.removeprefix('sha256:')
            assert (directory / 'source.txt').read_text().strip() == SOURCE
            continue
        receipt = json.loads((directory / 'package-result.json').read_text())
        assert receipt['sourceCommit'] == source and receipt['arch'] == arch and receipt['nativeRunner'] is True
        archive = directory / f'web-gateway-{source}-linux-{arch}.tar.gz'
        bundle = Path(str(archive) + '.sigstore.json')
        assert archive.is_file() and bundle.is_file() and sha(archive.read_bytes()) == receipt['archiveSha256']
        inputs[key] = dict(versionId=receipt['archiveSha256'], sourceCommit=source, signerCommit=source,
                           archive=str(archive.resolve()), bundle=str(bundle.resolve()), run=run)
    assert inputs['a']['versionId'] != inputs['b']['versionId']
    inputs.update(imageSource=SOURCE, imageDigest=digest, architecture=arch, imageRun=IMAGE_RUN)
    save(output / 'inputs.json', inputs)
    return inputs


def cleanup(output):
    allocation = output / 'allocation.json'
    if not allocation.exists(): return
    a = json.loads(allocation.read_text()); prefix = a['prefix']
    assert re.fullmatch('gateway-real-[a-f0-9]{12}', prefix)
    assert a['volumes'] == [prefix + '-private', prefix + '-cursor']
    work = Path(a['work']); assert work.parent == Path(tempfile.gettempdir()) and work.name.startswith(prefix + '-')
    def docker(*args): return execute(['docker', *args], check=False, timeout=45)
    ids = set()
    for label in ['com.docker.compose.project=' + prefix, 'bellteam.gateway-fixture=' + prefix]:
        ids.update(docker('ps', '-aq', '--filter', 'label=' + label).stdout.decode().split())
    for cid in ids:
        assert re.fullmatch('[a-f0-9]{12,64}', cid); assert docker('rm', '-f', cid).returncode == 0
    for name in a['volumes']:
        record = docker('volume', 'inspect', name)
        if record.returncode: continue
        assert json.loads(record.stdout)[0]['Labels'].get('bellteam.gateway-fixture') == prefix
        assert docker('volume', 'rm', name).returncode == 0
    if work.exists():
        code = 'import os; from pathlib import Path\nfor p in [Path("/fixture-work"),*Path("/fixture-work").rglob("*")]:\n if not p.is_symlink(): os.chown(p,' + str(os.getuid()) + ',' + str(os.getgid()) + ')'
        assert docker('run', '--pull', 'never', '--rm', '--network', 'none', '--read-only', '--user', '0:0',
            '--label', 'bellteam.gateway-fixture=' + prefix, '--mount', f'type=bind,source={work},target=/fixture-work', '--entrypoint', '/usr/bin/python3', a['imageId'], '-c', code).returncode == 0
        shutil.rmtree(work)
    remaining = []
    for label in ['com.docker.compose.project=' + prefix, 'bellteam.gateway-fixture=' + prefix]:
        remaining.extend(docker('ps', '-aq', '--filter', 'label=' + label).stdout.decode().split())
    remaining_volumes = docker('volume', 'ls', '-q', '--filter', 'label=bellteam.gateway-fixture=' + prefix).stdout.decode().split()
    assert not remaining and not remaining_volumes
    save(output / 'cleanup.json', dict(remainingContainers=remaining, remainingVolumes=remaining_volumes, workRemoved=not work.exists()))


def run_fixture(image, output, supply):
    assert re.fullmatch(r'ghcr\.io/kitepon/bellteam-server@' + DIGEST, image)
    inputs = json.loads((supply / 'inputs.json').read_text())
    assert image.endswith('@' + inputs['imageDigest']) and inputs['imageSource'] == SOURCE
    output.mkdir(parents=True, exist_ok=False)
    prefix = 'gateway-real-' + uuid.uuid4().hex[:12]
    work = Path(tempfile.mkdtemp(prefix=prefix + '-')); work.chmod(0o755)
    runtime = work / 'runtime'; runtime.mkdir(); (runtime / 'web-gateway-incoming').mkdir()
    for name in ['data', 'home']: (runtime / name).mkdir()
    saved = work / '.bellteam-compose.fixture'; saved.mkdir()
    guest = REPO / 'test/helpers/web-gateway-runtime-guest.mjs'
    shutil.copyfile(guest, work / 'guest.mjs'); (work / 'guest.mjs').chmod(0o644)
    save(work / 'fixture-input.json', {k: inputs[k]['versionId'] for k in ['a', 'b']}); (work / 'fixture-input.json').chmod(0o644)
    volumes = [prefix + '-private', prefix + '-cursor']
    report = dict(accepted=False, image=image, imageSource=SOURCE, inputs=inputs, stages=[],
                  scope='real signed/root/image caller; synthetic supervisor bootstrap/client/business; no AI/Host/production')
    def docker(*args, **kwargs):
        if args[0] == 'run': args = (args[0], '--label', 'bellteam.gateway-fixture=' + prefix, *args[1:])
        return execute(['docker', *args], cwd=work, **kwargs)
    def compose(*args, **kwargs): return docker('compose', '--project-directory', str(work), '-f', str(saved / 'normal.json'), *args, **kwargs)
    stage = 'image'
    try:
        im = json.loads(docker('image', 'inspect', image).stdout)[0]
        assert im['Architecture'] == inputs['architecture'] and im['Os'] == 'linux'
        assert im['Config']['Labels']['org.opencontainers.image.revision'] == SOURCE and image in im['RepoDigests']
        assert im['Config']['Entrypoint'] == ['/usr/local/libexec/bellteam-server-start']
        image_id = im['Id']; report['imageId'] = image_id
        save(output / 'allocation.json', dict(prefix=prefix, work=str(work), volumes=volumes, imageId=image_id))
        paths = ['scripts/install-web-gateway-release.py', 'scripts/verify-web-gateway.py', 'scripts/web_gateway_artifact.py',
                 'src/web-gateway-install-plan.mjs', 'src/web-gateway-release.mjs', 'src/application-runtime.mjs',
                 'src/http-application-api.mjs', 'src/web-gateway-control.mjs', 'src/http-gateway-process.mjs', 'src/http-gateway-entry.mjs']
        binding = {}
        for name in paths + ['install.sh']:
            raw = docker('run', '--pull', 'never', '--rm', '--network', 'none', '--read-only', '--entrypoint', '/bin/cat', image_id, '/app/' + name).stdout
            path = 'distribution/server/install.sh' if name == 'install.sh' else name
            assert raw == execute(['git', 'show', SOURCE + ':' + path], cwd=REPO).stdout
            binding[name] = dict(bytes=len(raw), sha256=sha(raw))
            if name == 'install.sh': (work / name).write_bytes(raw)
        save(output / 'image-code-binding.json', binding)
        for volume in volumes: docker('volume', 'create', '--label', 'bellteam.gateway-fixture=' + prefix, volume)
        stage = 'initialize'
        docker('run', '--pull', 'never', '--rm', '--network', 'none', '--read-only', '--user', '0:0',
            '--mount', f'type=volume,source={volumes[0]},target=/private,volume-nocopy',
            '--mount', f'type=bind,source={runtime},target=/fixture-runtime',
            '--mount', f'type=bind,source={work / "guest.mjs"},target=/fixture.mjs,readonly',
            '--entrypoint', '/usr/local/bin/node', image_id, '/fixture.mjs', 'initialize')
        mounts = [dict(type='bind', source=str(runtime / 'data'), target='/srv/bellteam'),
                  dict(type='bind', source=str(runtime / 'home'), target='/home/bell'),
                  dict(type='volume', source='cursor', target='/home/bell/.local'),
                  dict(type='volume', source='private', target='/run/bellteam-maintenance', read_only=True, volume=dict(nocopy=True)),
                  *[dict(type='volume', source='private', target='/srv/bellteam/' + part, volume=dict(nocopy=True, subpath=part.split('/')[-1])) for part in PARTS],
                  dict(type='bind', source=str(work / 'guest.mjs'), target='/app/src/supervisor.mjs', read_only=True),
                  dict(type='bind', source=str(work / 'fixture-input.json'), target='/fixture-input.json', read_only=True)]
        normal = dict(name=prefix, services=dict(bellteam=dict(image=image_id, pull_policy='never', user='1001:1001', init=True,
            read_only=True, network_mode='none', restart='no', volumes=mounts,
            tmpfs=['/tmp:rw,nosuid,nodev,size=64m', '/run:size=64m', '/run/bellteam-server:uid=1001,gid=1001,mode=0700,size=64m'])),
            volumes=dict(private=dict(external=True, name=volumes[0]), cursor=dict(external=True, name=volumes[1])))
        save(saved / 'normal.json', normal); save(output / 'normal.json', normal)
        compose('up', '-d', '--pull', 'never', '--no-build', 'bellteam')
        cid = compose('ps', '--all', '--quiet', '--no-trunc', 'bellteam').stdout.decode().strip()
        def inspection():
            c = json.loads(docker('container', 'inspect', cid).stdout)[0]
            return dict(id=c['Id'], image=c['Image'], pid=c['State']['Pid'], running=c['State']['Running'], restarting=c['State']['Restarting'],
                        readOnly=c['HostConfig']['ReadonlyRootfs'], user=c['Config']['User'], mounts=c['Mounts'], specMounts=c['HostConfig']['Mounts'])
        before = inspection(); save(output / 'container-before.json', before)
        assert before['running'] and before['readOnly'] and before['user'] == '1001:1001'
        def guest_call(*args): return docker('exec', '--user', '1001:1001', cid, '/usr/local/bin/node', '/app/src/supervisor.mjs', *args)
        def wait_phase(expected):
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                c = docker('exec', '--user', '1001:1001', cid, '/usr/local/bin/node', '/app/src/supervisor.mjs', 'status', check=False)
                if c.returncode == 0:
                    value = json.loads(c.stdout)
                    if value['phase'] == 'failed': raise RuntimeError(value['error'])
                    if value['phase'] == expected:
                        save(output / (expected + '.json'), value); return value
                if not inspection()['running']: raise RuntimeError('FIXTURE_PARENT_EXITED')
                time.sleep(.25)
            raise TimeoutError('phase ' + expected)
        def snapshot():
            code = '''const f=require('node:fs'),c=require('node:crypto'),p='/run/bellteam-maintenance/web-gateway/releases';
const versions=f.existsSync(p)?f.readdirSync(p).sort():[];
const a='/srv/bellteam/state/web-gateway-release.json',component='/run/bellteam-maintenance/web-gateway';
const staging=f.existsSync(component)?f.readdirSync(component).filter(n=>n.startsWith('.staging-')):[];
const installations=Object.fromEntries(versions.map(id=>{const file=p+'/'+id+'/installation.json',st=f.lstatSync(file),dir=f.lstatSync(p+'/'+id);return[id,{uid:st.uid,mode:st.mode&4095,dirUid:dir.uid,dirMode:dir.mode&4095,record:JSON.parse(f.readFileSync(file))}]}));
console.log(JSON.stringify({versions,staging,installations,adoption:f.existsSync(a)?c.createHash('sha256').update(f.readFileSync(a)).digest('hex'):null}))'''
            return json.loads(docker('exec', '--user', '1001:1001', cid, '/usr/local/bin/node', '-e', code).stdout)
        def install(value, *, archive=None, source=None, expect_success=True, label):
            dest = runtime / 'web-gateway-incoming' / value['versionId']; dest.mkdir(exist_ok=True)
            shutil.copyfile(archive or value['archive'], dest / 'archive.tar.gz'); shutil.copyfile(value['bundle'], dest / 'bundle.json')
            c = execute(['sh', str(work / 'install.sh'), '--install-web-gateway', str(saved), value['versionId'], source or value['sourceCommit'], value['signerCommit']], cwd=work, timeout=150, check=False)
            save(output / (label + '.json'), dict(exit=c.returncode, stdout=c.stdout.decode(), stderr=c.stderr.decode()))
            assert (c.returncode == 0) == expect_success, label
            if expect_success: assert json.loads(c.stdout)['versionId'] == value['versionId']
        stage = 'admit-normal'; wait_phase('ready')
        lock = docker('run', '--pull', 'never', '--rm', '--network', 'none', '--read-only', '--user', '0:0',
            '--mount', f'type=volume,source={volumes[0]},target=/private,volume-nocopy',
            '--entrypoint', '/usr/bin/flock', image_id, '-x', '-n', '-E', '75', '/private', '/bin/true', check=False)
        assert lock.returncode == 75; report['privateWholeEXRejectedWhileNormalSH'] = True
        stage = 'install-a'; install(inputs['a'], label=stage); guest_call('command', 'adopt-a'); held = wait_phase('a-held')
        original = snapshot(); assert original['versions'] == [inputs['a']['versionId']] and original['staging'] == []
        save(output / 'root-after-a.json', original)
        stage = 'reject-tamper'; changed = work / 'changed.tar.gz'; changed.write_bytes(Path(inputs['a']['archive']).read_bytes() + b'x')
        invalid = dict(inputs['a'], versionId=sha(changed.read_bytes()))
        install(invalid, archive=changed, expect_success=False, label=stage); assert snapshot() == original
        stage = 'reject-source'; install(inputs['b'], source='0' * 40, expect_success=False, label=stage); assert snapshot() == original
        stage = 'install-b-online'; install(inputs['b'], label=stage); assert snapshot()['adoption'] == original['adoption']
        guest_call('command', 'adopt-b'); wait_phase('b-active')
        guest_call('command', 'return-a'); final = wait_phase('done')
        stage = 'verify-final'
        after = inspection(); compare_inspections(before, after, output)
        assert final['parent'] == held['parent'] and final['business'] == held['business'] and final['port'] == held['port']
        assert final['clientCloses'] == 0 and final['modelCalls'] == 1
        installed = snapshot()
        assert installed['versions'] == sorted([inputs['a']['versionId'], inputs['b']['versionId']]) and installed['staging'] == []
        for key in ['a', 'b']:
            record = installed['installations'][inputs[key]['versionId']]
            assert record['uid'] == record['dirUid'] == 0 and record['mode'] == 0o444 and record['dirMode'] == 0o555
            assert record['record']['sourceCommit'] == inputs[key]['sourceCommit']
            assert record['record']['verification'] == dict(method='github-oidc-attestation', repositoryId='1404510084')
        save(output / 'root-after-return.json', installed)
        report.update(accepted=True, parentCIDAndPIDUnchanged=True, businessPIDAndStartUnchanged=True,
                      realSignedRootInstall=True, rejectedBeforePublication=['tampered-archive', 'wrong-source'], final=final)
    except BaseException as error:
        report.update(failedStage=stage, error=str(error) or type(error).__name__); raise
    finally:
        try:
            if 'image_id' in locals():
                try:
                    logs = compose('logs', '--no-color', 'bellteam', check=False)
                    (output / 'container.log').write_bytes(logs.stdout + logs.stderr)
                except Exception:
                    report['logCaptureFailed'] = True
            cleanup(output)
            if not (output / 'allocation.json').exists(): shutil.rmtree(work)
        except BaseException as error:
            report.update(accepted=False, cleanupError=str(error)); raise
        finally: save(output / 'result.json', report)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    fetch = commands.add_parser('fetch'); fetch.add_argument('b_run', type=int); fetch.add_argument('digest'); fetch.add_argument('output', type=Path)
    run = commands.add_parser('run'); run.add_argument('image'); run.add_argument('output', type=Path); run.add_argument('supply', type=Path)
    clean = commands.add_parser('cleanup'); clean.add_argument('output', type=Path)
    args = parser.parse_args()
    if args.command == 'fetch': fetch_inputs(args.b_run, args.digest, args.output.resolve())
    elif args.command == 'run': run_fixture(args.image, args.output.resolve(), args.supply.resolve())
    else: cleanup(args.output.resolve())


if __name__ == '__main__':
    def interrupted(_signum, _frame): raise KeyboardInterrupt('fixture interrupted')
    signal.signal(signal.SIGTERM, interrupted); signal.signal(signal.SIGINT, interrupted)
    main()
