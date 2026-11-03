#!/usr/bin/env python3
"""Pull-only, finite real C/UID/FD/mount and synthetic request storage proof."""
import argparse
import importlib.util
import json
import platform
from pathlib import Path
import re
import shutil
import tempfile
import uuid

spec = importlib.util.spec_from_file_location('shared', Path(__file__).with_name('web-gateway-real-boundary.py'))
shared = importlib.util.module_from_spec(spec); spec.loader.exec_module(shared)
execute, save, cleanup = shared.execute, shared.save, shared.cleanup


def validate(image, source):
    assert re.fullmatch(r'ghcr\.io/kitepon/bellteam-server@sha256:[a-f0-9]{64}', image)
    assert re.fullmatch('[a-f0-9]{40}', source)


def run(image, source, output):
    validate(image, source)
    output.mkdir(parents=True, exist_ok=False)
    prefix = 'gateway-real-' + uuid.uuid4().hex[:12]
    volumes = [prefix + '-private', prefix + '-cursor']
    report = dict(source=source, image=image, accepted=False, syntheticSupervisor=True,
                  scope='actual C/UID1001/FD3-4/mount acquisition and real consumer synthetic request storage; no SDK, seat or historical recovery')
    def docker(*args, **kwargs):
        return execute(['docker', *args], timeout=60, **kwargs)
    # Resolve before allocating Docker objects; cleanup uses this exact immutable image ID.
    inspected = json.loads(docker('image', 'inspect', image).stdout)[0]
    assert inspected['Architecture'] == {'x86_64': 'amd64', 'aarch64': 'arm64'}[platform.machine()]
    assert inspected['Os'] == 'linux' and image in inspected['RepoDigests']
    assert inspected['Config']['Labels']['org.opencontainers.image.revision'] == source
    assert inspected['Config']['Entrypoint'] == ['/usr/local/libexec/bellteam-server-start']
    image_id = inspected['Id']; report['imageId'] = image_id; report['architecture'] = inspected['Architecture']
    work = Path(tempfile.mkdtemp(prefix=prefix + '-')); work.chmod(0o755)
    save(output / 'allocation.json', dict(prefix=prefix, work=str(work), volumes=volumes, imageId=image_id))
    try:
        (work / 'data').mkdir()
        shutil.copyfile(Path(__file__).with_name('configuration-state-guest.mjs'), work / 'guest.mjs')
        (work / 'guest.mjs').chmod(0o644)
        docker('volume', 'create', '--label', 'bellteam.gateway-fixture=' + prefix, volumes[0])
        initialized = docker('run', '--pull', 'never', '--rm', '--network', 'none', '--read-only', '--user', '0:0',
            '--label', 'bellteam.gateway-fixture=' + prefix,
            '--mount', f'type=volume,source={volumes[0]},target=/private,volume-nocopy',
            '--mount', f'type=bind,source={work / "data"},target=/fixture-data',
            '--mount', f'type=bind,source={work / "guest.mjs"},target=/fixture.mjs,readonly',
            '--entrypoint', '/usr/local/bin/node', image_id, '/fixture.mjs', 'initialize')
        (output / 'initialize.log').write_bytes(initialized.stdout + initialized.stderr)
        cid = docker('create', '--pull', 'never', '--network', 'none', '--read-only', '--user', '1001:1001', '--init',
            '--label', 'bellteam.gateway-fixture=' + prefix,
            '--mount', f'type=bind,source={work / "data"},target=/srv/bellteam',
            '--mount', f'type=volume,source={volumes[0]},target=/run/bellteam-maintenance,readonly,volume-nocopy',
            '--mount', f'type=volume,source={volumes[0]},target=/srv/bellteam/state,volume-subpath=state,volume-nocopy',
            '--mount', f'type=bind,source={work / "guest.mjs"},target=/app/src/supervisor.mjs,readonly',
            '--tmpfs', '/run:mode=0755,size=64m', '--tmpfs', '/run/bellteam-server:uid=1001,gid=1001,mode=0700,size=64m', image_id).stdout.decode().strip()
        assert re.fullmatch('[a-f0-9]{64}', cid)
        started = docker('start', '-a', cid, check=False)
        (output / 'guest.stdout.log').write_bytes(started.stdout); (output / 'guest.stderr.log').write_bytes(started.stderr)
        container = json.loads(docker('inspect', cid).stdout)[0]; save(output / 'container.json', container)
        assert started.returncode == container['State']['ExitCode'] == 0
        assert container['State']['Running'] is False and container['HostConfig']['ReadonlyRootfs'] is True
        result = json.loads(started.stdout)
        assert result['source'] == source and result['actualFd3Fd4AndMountsVerified'] and result['realConsumerPublishReadAndNotIssued']
        assert result['uid'] == 1001 and result['nativeConfigurationRpc'] == result['historicalRequestsTouched'] == 0
        save(output / 'storage-proof.json', result); report['accepted'] = True
    finally:
        cleanup(output)
        save(output / 'result.json', report)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cleanup', type=Path); parser.add_argument('--self-check', action='store_true')
    parser.add_argument('inputs', nargs='*'); args = parser.parse_args()
    if args.cleanup:
        cleanup(args.cleanup)
    elif args.self_check:
        good = 'ghcr.io/kitepon/bellteam-server@sha256:' + 'a' * 64
        validate(good, 'b' * 40)
        for image, source in [('ghcr.io/kitepon/bellteam-server:latest', 'b' * 40), (good, 'main')]:
            try: validate(image, source)
            except AssertionError: pass
            else: raise AssertionError('mutable input accepted')
        print('PASS immutable input and malformed input rejection')
    else:
        assert len(args.inputs) == 3
        run(args.inputs[0], args.inputs[1], Path(args.inputs[2]))
