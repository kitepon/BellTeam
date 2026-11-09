import importlib.util
import io
from types import SimpleNamespace
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import PropertyMock, patch

spec = importlib.util.spec_from_file_location('container_service', Path(__file__).parents[1] / 'scripts/container-update-service.py')
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)
host = service.host


class ContainerUpdaterTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=Path(__file__).parents[1])
        self.addCleanup(self.temporary.cleanup)
        self.prefix = Path(self.temporary.name)
        (self.prefix / 'state').mkdir(mode=0o700)
        self.config = dict(projectName='fixed-project', workerImage='sha256:' + 'a' * 64,
                           volumeName='fixed-project-container-updater', volumeRoot='/var/lib/docker/volumes/fixed/_data',
                           release='b' * 40, platform=dict(os='linux', arch='amd64'),
                           docker=service.DOCKER, python=sys.executable, shell='/bin/sh')
        self.current = dict(containerId='1' * 64, imageId=self.config['workerImage'], sourceCommit='b' * 40,
                            imageRef='ghcr.io/kitepon/bellteam-server@sha256:' + 'c' * 64, health='healthy')
        self.updater = service.ContainerUpdater(self.prefix, self.config, uid=os.getuid(), inspect=lambda: self.current)
        self.identifier = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        self.record = dict(id='2' * 64, image=self.config['workerImage'], running=True, started='fixed-birth',
                           labels={'bellteam.container-update.request': self.identifier,
                                   'bellteam.container-update.project': self.config['projectName']})

    def test_fixed_docker_worker_authority_and_identity_survive_admission_image_change(self):
        commands = []
        def command(args, **options):
            commands.append(args)
            return json.dumps(self.record).encode() if args[1:3] == ['container', 'inspect'] else b'2' * 64
        self.updater.command = command
        self.updater.launch_service(self.identifier)
        args = commands[0]
        self.assertIn('--detach', args); self.assertIn('--rm', args)
        self.assertNotIn('--restart', args)  # Docker's default is no restart; compatible with --rm.
        self.assertEqual(args[args.index('--entrypoint') + 1:],
                         ['/usr/bin/python3', self.config['workerImage'], '-I', '-B', service.ENTRY, '--worker', self.identifier])
        mounts = [args[i + 1] for i, value in enumerate(args[:-1]) if value == '--mount']
        self.assertEqual(len(mounts), 3)
        self.assertTrue(all('fixed-project-container-updater' in value or value == 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock' for value in mounts))
        self.assertNotIn('--privileged', args); self.assertNotIn('--env', args)
        worker = self.updater.worker_identity(self.identifier)
        self.config['workerImage'] = 'sha256:' + 'd' * 64  # A new daemon reads the same in-flight operation.
        self.assertTrue(self.updater.worker_alive(worker))
        self.record['started'] = 'different-birth'
        self.assertFalse(self.updater.worker_alive(worker))
        self.record['started'] = 'fixed-birth'; self.record['labels']['bellteam.container-update.project'] = 'other'
        self.assertFalse(self.updater.worker_alive(worker))
        with self.assertRaises(host.Failure): self.updater.launch_service('not-a-uuid')
        self.assertEqual(sum(args[1:2] == ['run'] for args in commands), 1)

    def test_one_claim_durable_ack_same_id_get_and_lost_worker_never_relaunch(self):
        self.updater.command = lambda *_args, **_kwargs: json.dumps(self.record).encode()
        self.updater.assert_model_binding = lambda *_args: None
        target = dict(componentId='container', versionId='sha256:' + 'e' * 64)
        self.updater.planned_target = lambda _plan: target
        plan_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        host.atomic(self.updater.state / 'plans' / (plan_id + '.json'),
                    dict(planId=plan_id, catalogSha256='a'*64, target=target, expected=self.current, expiresAt='2099-01-01T00:00:00Z',
                         impact=dict(containerRestart=True)))
        effects = []
        def execute(_plan,directory):
            effects.append('once');self.updater.progress(directory,'verifying');self.updater.progress(directory,'swapping')
            return dict(execution='succeeded',verification='succeeded',cleanup='succeeded',rollback='not_needed',observed=self.current,error=None)
        self.updater.execute=execute
        self.updater.launcher = self.updater.worker
        params = dict(requestId=self.identifier, planId=plan_id, confirmContainerRestart=True)
        self.assertEqual(self.updater.start(params)['phase'], 'completed')
        self.assertEqual(self.updater.start(params)['phase'], 'completed')
        self.assertEqual(effects, ['once'])
        value = self.updater.read_operation(self.identifier)
        self.assertEqual(value['worker']['containerId'], self.record['id'])
        self.assertTrue((self.updater.state / 'operations' / self.identifier / 'claimed').is_file())
        value['phase'] = 'applying'
        job=self.updater.read_job(self.identifier);job['state']='swapping';job['transitions']=job['transitions'][:-1];job['updatedAtNs']=job['transitions'][-1]['atNs']
        host.atomic(self.updater.state/'jobs'/(self.identifier+'.json'),job)
        host.atomic(self.updater.state / 'operations' / self.identifier / 'operation.json', value)
        self.updater.launcher = lambda _id: self.fail('GET/repeated UUID must not launch')
        self.record['running'] = False
        self.assertEqual(self.updater.get(self.identifier)['phase'], 'failed')
        self.assertEqual(self.updater.start(params)['phase'], 'failed')
        self.assertEqual(effects, ['once'])
        with self.assertRaises(host.Failure): self.updater.module_target('any', 'any', 'any')

    def test_configure_binds_final_normal_and_rejects_changed_current_or_foreign_volume(self):
        normal = dict(name=self.config['projectName'], services=dict(bellteam=dict(image=self.current['imageId'], environment={'LARGE_SETTING': 'x' * 70000})))
        metadata = dict(Name=self.config['volumeName'], Driver='local', Options={},
                        Mountpoint=self.config['volumeRoot'], Labels={
                            'com.docker.compose.project': self.config['projectName'],
                            'com.docker.compose.volume': 'container-updater'})
        actual_class = service.ContainerUpdater
        def create(prefix, config):
            updater = actual_class(prefix, config, uid=os.getuid())
            updater.command = lambda *_args, **_kwargs: json.dumps(metadata).encode()
            updater.inspect_current = lambda: self.current
            updater.assert_model_binding = lambda current, model: self.assertEqual((current, model), (self.current, normal))
            return updater
        def configure():
            with patch.object(service, 'PREFIX', self.prefix), \
                 patch.object(service, 'distribution', return_value=(self.config['release'], self.config['platform'])), \
                 patch.object(service, 'ContainerUpdater', side_effect=create), \
                 patch.object(sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(json.dumps(normal).encode()))):
                service.configure()
        (self.prefix / 'installation').mkdir()
        configure()
        saved = (self.prefix / 'config.json').read_bytes()
        self.assertEqual(host.read_json(self.prefix / 'installation/normal.json', os.getuid(), host.CATALOG_LIMIT), normal)
        self.assertEqual(json.loads(saved)['installRoot'], self.config['volumeRoot'] + '/installation/work')
        self.assertEqual(json.loads(saved)['channel'], 'stable')  # no BELLTEAM_UPDATE_CHANNEL in the model = stable
        self.current['sourceCommit'] = 'f' * 40
        with self.assertRaises(host.Failure): configure()
        self.current['sourceCommit'] = self.config['release']
        metadata['Options'] = {'device': '/foreign'}
        with self.assertRaises(host.Failure): configure()
        self.assertEqual((self.prefix / 'config.json').read_bytes(), saved)

    def test_shared_installer_uses_image_code_root_and_preserves_extra_service_settings(self):
        release = self.prefix / 'image'; (release / 'scripts').mkdir(parents=True)
        (release / 'scripts/cleanup-deploy-images.py').write_text('# mocked cleanup')
        install = self.prefix / 'work'; install.mkdir()
        (self.prefix / 'installation').mkdir()
        normal = dict(name='fixed-project', services=dict(bellteam=dict(image=self.current['imageId']),
                     dependency=dict(image='separate:image', environment=dict(KEEP='literal-$$value'))))
        host.atomic(self.prefix / 'installation/normal.json', normal)
        self.config['installRoot'] = str(install)
        (release / 'install.sh').write_text('''#!/bin/sh
set -eu
test -z "${MUST_NOT_LEAK:-}"
saved="$BELLTEAM_INSTALL_DIR/.bellteam-compose.ABC123"
mkdir "$saved"
cp "$COMPOSE_FILE" "$saved/normal.json"
cp "$BELLTEAM_PREVIOUS_COMPOSE" "$saved/previous-normal.json"
cp "$(dirname "$BELLTEAM_PREVIOUS_COMPOSE")/previous-runtime.json" "$saved/previous-runtime.json"
printf 'saved-compose=%s\\n' "$saved"
touch "$BELLTEAM_INSTALL_DIR/applied"
''')
        selected = 'sha256:' + 'f' * 64
        def command(args, **options):
            return selected.encode() if args[1:3] == ['image', 'inspect'] else b''
        self.updater.command = command
        self.updater.inspect_current = lambda: ({**self.current, 'imageId': selected, 'sourceCommit': 'e' * 40}
            if (install / 'applied').exists() else self.current)
        self.updater.assert_model_binding = lambda *_args: None
        plan = dict(target=dict(componentId='container', sourceCommit='e' * 40,
                    artifact=dict(reference='ghcr.io/kitepon/bellteam-server@sha256:' + 'e' * 64)),
                    expected=self.current, planId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
        directory = self.updater.state / 'result'; directory.mkdir()
        self.updater.progress = lambda *_: None  # Direct installer fixture; job progression is checked separately.
        with patch.object(service.ContainerUpdater, 'code_root', new_callable=PropertyMock, return_value=release), \
             patch.dict(os.environ, {'MUST_NOT_LEAK': 'private'}):
            result = host.execute_installer(self.updater, plan, directory)
        self.assertEqual(result['verification'], 'succeeded')
        saved = host.read_json(self.prefix / 'installation/normal.json', os.getuid())
        self.assertEqual(saved['services']['dependency'], normal['services']['dependency'])
        self.assertEqual(saved['services']['bellteam']['image'], plan['target']['artifact']['reference'])


if __name__ == '__main__':
    unittest.main()
