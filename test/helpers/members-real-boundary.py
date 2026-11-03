#!/usr/bin/env python3
"""Members builtin -> same-source signed archive -> builtin; pull-only native fixture."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import tempfile
import time
import uuid

REPO = Path(__file__).resolve().parents[2]
# Reuse the existing finite allocation/cleanup contract, including its ownership labels.
spec = importlib.util.spec_from_file_location('web_fixture', Path(__file__).with_name('web-gateway-real-boundary.py'))
shared = importlib.util.module_from_spec(spec); spec.loader.exec_module(shared)
execute, save, sha, api = shared.execute, shared.save, shared.sha, shared.api
extract_artifact, cleanup, compare_inspections = shared.extract_artifact, shared.cleanup, shared.compare_inspections
PARTS, DIGEST = shared.PARTS, shared.DIGEST


def validate_inputs(source, supply_run, image_run, digest):
    assert re.fullmatch('[a-f0-9]{40}', source) and re.fullmatch(DIGEST, digest)
    assert type(supply_run) is int and type(image_run) is int and supply_run > 0 and image_run > 0 and supply_run != image_run


def fetch_inputs(source, supply_run, image_run, digest, output):
    validate_inputs(source, supply_run, image_run, digest)
    arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}[platform.machine()]
    output.mkdir(parents=True, exist_ok=False)
    for key, run, workflow, artifact in [
        ('b', supply_run, 'publish-members.yml', f'members-{arch}-1'),
        ('image', image_run, 'publish-server-image.yml', 'server-image-index-1')]:
        record = json.loads(api(f'actions/runs/{run}'))
        assert record['head_sha'] == source and record['run_attempt'] == 1 and record['conclusion'] == 'success'
        assert record['repository']['id'] == 1404510084 and record['path'] == '.github/workflows/' + workflow
        assert record['event'] == ('push' if key == 'image' else 'workflow_dispatch')
        save(output / (key + '-run.json'), record)
        extract_artifact(run, artifact, output / key)
    assert sha((output / 'image/index.json').read_bytes()) == digest.removeprefix('sha256:')
    assert (output / 'image/source.txt').read_text().strip() == source
    directory = output / 'b'
    receipt = json.loads((directory / 'package-result.json').read_text())
    assert receipt['sourceCommit'] == source and receipt['arch'] == arch and receipt['nativeRunner'] is True
    archive = directory / f'members-{source}-linux-{arch}.tar.gz'
    bundle = Path(str(archive) + '.sigstore.json')
    assert bundle.is_file() and sha(archive.read_bytes()) == receipt['archiveSha256']
    inputs = dict(b=dict(versionId=receipt['archiveSha256'], sourceCommit=source, signerCommit=source,
                       archive=str(archive.resolve()), bundle=str(bundle.resolve()), run=supply_run),
                  imageSource=source, imageDigest=digest, architecture=arch, imageRun=image_run)
    save(output / 'inputs.json', inputs)
    return inputs


def run_fixture(image, output, supply):
    assert re.fullmatch(r'ghcr\.io/kitepon/bellteam-server@' + DIGEST, image)
    inputs = json.loads((supply / 'inputs.json').read_text())
    assert image.endswith('@' + inputs['imageDigest']) and re.fullmatch('[a-f0-9]{40}', inputs['imageSource'])
    source = inputs['imageSource']
    output.mkdir(parents=True, exist_ok=False)
    prefix = 'gateway-real-' + uuid.uuid4().hex[:12]
    work = Path(tempfile.mkdtemp(prefix=prefix + '-')); work.chmod(0o755)
    runtime = work / 'runtime'; runtime.mkdir(); (runtime / 'members-incoming').mkdir()
    for name in ['data', 'home']: (runtime / name).mkdir()
    saved = work / '.bellteam-compose.fixture'; saved.mkdir()
    guest = REPO / 'test/helpers/members-runtime-guest.mjs'
    shutil.copyfile(guest, work / 'guest.mjs'); (work / 'guest.mjs').chmod(0o644)
    save(work / 'fixture-input.json', dict(b=inputs['b']['versionId'], source=source)); (work / 'fixture-input.json').chmod(0o644)
    volumes = [prefix + '-private', prefix + '-cursor']
    report = dict(accepted=False, image=image, imageSource=source, inputs=inputs, stages=[],
                  scope='real signed/root/image caller; synthetic supervisor bootstrap/client/business; controller boundary only; no public update coordinator/AI/Host/production')
    def docker(*args, **kwargs):
        if args[0] == 'run': args = (args[0], '--label', 'bellteam.gateway-fixture=' + prefix, *args[1:])
        return execute(['docker', *args], cwd=work, **kwargs)
    def compose(*args, **kwargs): return docker('compose', '--project-directory', str(work), '-f', str(saved / 'normal.json'), *args, **kwargs)
    stage = 'image'
    try:
        im = json.loads(docker('image', 'inspect', '--platform', 'linux/' + inputs['architecture'], image).stdout)[0]
        assert im['Architecture'] == inputs['architecture'] and im['Os'] == 'linux'
        assert im['Config']['Labels']['org.opencontainers.image.revision'] == source and image in im['RepoDigests']
        assert im['Config']['Entrypoint'] == ['/usr/local/libexec/bellteam-server-start']
        image_id = im['Id']; report['imageId'] = image_id
        save(output / 'allocation.json', dict(prefix=prefix, work=str(work), volumes=volumes, imageId=image_id))
        paths = ['scripts/install-web-gateway-release.py', 'scripts/install-members-release.py',
                 'scripts/verify-members.py', 'scripts/module_artifact_verifier.py', 'scripts/web_gateway_artifact.py',
                 'src/members-install-plan.mjs', 'src/web-gateway-install-plan.mjs', 'src/members-release.mjs',
                 'src/web-gateway-release.mjs', 'src/members-process.mjs', 'src/members-ipc.mjs', 'src/members-locks.mjs',
                 'src/members-entry.mjs', 'src/members-assembly.mjs', 'src/members-facade.mjs', 'src/members-projection.mjs',
                 'src/members/protocol.mjs', 'src/members/dispatcher.mjs', 'src/members/state-compatibility.mjs',
                 'src/application-runtime.mjs', 'src/application-services.mjs', 'config/members-verification.json',
                 'config/web-gateway-trusted-root.jsonl']
        binding = {}
        for name in paths + ['install.sh']:
            raw = docker('run', '--pull', 'never', '--rm', '--network', 'none', '--read-only', '--entrypoint', '/bin/cat', image_id, '/app/' + name).stdout
            path = 'distribution/server/install.sh' if name == 'install.sh' else name
            assert raw == execute(['git', 'show', source + ':' + path], cwd=REPO).stdout
            binding[name] = dict(bytes=len(raw), sha256=sha(raw))
            if name == 'install.sh': (work / name).write_bytes(raw)
        save(output / 'image-code-binding.json', binding)
        for volume in volumes: docker('volume', 'create', '--label', 'bellteam.gateway-fixture=' + prefix, volume)
        stage = 'initialize'
        docker('run', '--pull', 'never', '--rm', '--network', 'none', '--read-only', '--user', '0:0',
            '--mount', f'type=volume,source={volumes[0]},target=/private,volume-nocopy',
            '--mount', f'type=bind,source={runtime},target=/fixture-runtime',
            '--mount', f'type=bind,source={work / "guest.mjs"},target=/fixture.mjs,readonly',
            '--mount', f'type=bind,source={REPO / "test/fixtures/members-saved-state/root"},target=/fixture-members-state,readonly',
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
            code = '''const f=require('node:fs'),c=require('node:crypto'),p='/run/bellteam-maintenance/members/releases';
const versions=f.existsSync(p)?f.readdirSync(p).sort():[];
const a='/srv/bellteam/state/members-release.json',component='/run/bellteam-maintenance/members';
const staging=f.existsSync(component)?f.readdirSync(component).filter(n=>n.startsWith('.staging-')):[];
const installations=Object.fromEntries(versions.map(id=>{const file=p+'/'+id+'/installation.json',st=f.lstatSync(file),dir=f.lstatSync(p+'/'+id);return[id,{uid:st.uid,mode:st.mode&4095,dirUid:dir.uid,dirMode:dir.mode&4095,record:JSON.parse(f.readFileSync(file))}]}));
console.log(JSON.stringify({versions,staging,installations,adoption:f.existsSync(a)?c.createHash('sha256').update(f.readFileSync(a)).digest('hex'):null}))'''
            return json.loads(docker('exec', '--user', '1001:1001', cid, '/usr/local/bin/node', '-e', code).stdout)
        def install(value, *, archive=None, source=None, expect_success=True, label):
            dest = runtime / 'members-incoming' / value['versionId']; dest.mkdir(exist_ok=True)
            shutil.copyfile(archive or value['archive'], dest / 'archive.tar.gz'); shutil.copyfile(value['bundle'], dest / 'bundle.json')
            c = execute(['sh', str(work / 'install.sh'), '--install-members', str(saved), value['versionId'], source or value['sourceCommit'], value['signerCommit']], cwd=work, timeout=150, check=False)
            save(output / (label + '.json'), dict(exit=c.returncode, stdout=c.stdout.decode(), stderr=c.stderr.decode()))
            assert (c.returncode == 0) == expect_success, label
            if expect_success: assert json.loads(c.stdout)['versionId'] == value['versionId']
        stage = 'admit-normal'; wait_phase('ready')
        lock = docker('run', '--pull', 'never', '--rm', '--network', 'none', '--read-only', '--user', '0:0',
            '--mount', f'type=volume,source={volumes[0]},target=/private,volume-nocopy',
            '--entrypoint', '/usr/bin/flock', image_id, '-x', '-n', '-E', '75', '/private', '/bin/true', check=False)
        assert lock.returncode == 75; report['privateWholeEXRejectedWhileNormalSH'] = True
        original = snapshot(); assert original['versions'] == [] and original['staging'] == []
        held = wait_phase('ready'); save(output / 'root-before.json', original)
        stage = 'reject-tamper'; changed = work / 'changed.tar.gz'; changed.write_bytes(Path(inputs['b']['archive']).read_bytes() + b'x')
        invalid = dict(inputs['b'], versionId=sha(changed.read_bytes()))
        install(invalid, archive=changed, expect_success=False, label=stage); assert snapshot() == original
        stage = 'reject-source'; install(inputs['b'], source='0' * 40, expect_success=False, label=stage); assert snapshot() == original
        stage = 'install-b-online'; install(inputs['b'], label=stage); assert snapshot()['adoption'] == original['adoption']
        guest_call('command', 'adopt-b'); active = wait_phase('b-active')
        guest_call('command', 'return-a'); final = wait_phase('done')
        stage = 'verify-final'
        after = inspection(); compare_inspections(before, after, output)
        for key in ['parent', 'business', 'gateway', 'port', 'savedStateSha256', 'writerLock']:
            assert final[key] == held[key], key
        assert final['sharedMcpClientConstructed'] is False and final['currentVersionId'] is None
        assert active['member'] != held['member'] and final['member'] != active['member']
        installed = snapshot()
        assert installed['versions'] == [inputs['b']['versionId']] and installed['staging'] == []
        record = installed['installations'][inputs['b']['versionId']]
        assert record['uid'] == record['dirUid'] == 0 and record['mode'] == 0o444 and record['dirMode'] == 0o555
        assert record['record']['schema'] == 'bellteam.members.installation.v1'
        assert record['record']['sourceCommit'] == source
        assert record['record']['verification'] == dict(method='github-oidc-attestation', repositoryId='1404510084')
        save(output / 'root-after-return.json', installed)
        guest_call('command', 'finish'); closed = wait_phase('closed')
        assert closed['membersChildEnded'] and closed['gatewayAndBusinessClosed']
        report.update(accepted=True, childOsCloseConfirmed=True, parentCIDAndPIDUnchanged=True, businessPIDAndStartUnchanged=True,
                      gatewayPIDAndStartUnchanged=True, savedStateAndWriterLockUnchanged=True,
                      sameSourceBuiltinArchiveBuiltinOnly=True, realSignedRootInstall=True,
                      rejectedBeforePublication=['tampered-archive', 'wrong-source'], final=final)
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
    fetch = commands.add_parser('fetch'); fetch.add_argument('source'); fetch.add_argument('supply_run', type=int); fetch.add_argument('image_run', type=int); fetch.add_argument('digest'); fetch.add_argument('output', type=Path)
    run = commands.add_parser('run'); run.add_argument('image'); run.add_argument('output', type=Path); run.add_argument('supply', type=Path)
    clean = commands.add_parser('cleanup'); clean.add_argument('output', type=Path)
    args = parser.parse_args()
    if args.command == 'fetch': fetch_inputs(args.source, args.supply_run, args.image_run, args.digest, args.output.resolve())
    elif args.command == 'run': run_fixture(args.image, args.output.resolve(), args.supply.resolve())
    else: cleanup(args.output.resolve())


if __name__ == '__main__':
    def interrupted(_signum, _frame): raise KeyboardInterrupt('fixture interrupted')
    signal.signal(signal.SIGTERM, interrupted); signal.signal(signal.SIGINT, interrupted)
    main()
