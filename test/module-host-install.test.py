import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import time
import unittest
import urllib.request
import uuid
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('host_fixtures', Path(__file__).with_name('container-update-host.test.py'))
fixtures = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixtures)
module = fixtures.module


class ModuleHostTest(unittest.TestCase):
    writable = fixtures.HostTest.writable
    join = fixtures.HostTest.join
    make_catalog = fixtures.HostTest.make_catalog
    install_catalog = fixtures.HostTest.install_catalog
    launch = fixtures.HostTest.launch
    execute = fixtures.HostTest.execute

    def setUp(self):
        fixtures.HostTest.setUp(self)
        self.archive, self.bundle = b'artificial-archive', b'artificial-bundle'
        self.version = hashlib.sha256(self.archive).hexdigest()
        url = 'https://github.com/kitepon/BellTeam/releases/download/updates-20261104T001000Z/diagnostics-' + 'd'*40 + '-linux-amd64.tar.gz'
        self.target = {'componentId': 'diagnostics', 'sourceCommit': 'd'*40, 'versionId': self.version,
                      'platform': self.config['platform'], 'changes': [],
                      'artifact': {'kind': 'archive', 'signerCommit': 'f'*40,
                          'archive': {'url': url, 'sha256': self.version, 'bytes': len(self.archive)},
                          'bundle': {'url': url + '.sigstore.json', 'sha256': hashlib.sha256(self.bundle).hexdigest(), 'bytes': len(self.bundle)}},
                      'compatibility': {'nodeMajor': 26, 'parentProtocol': 1, 'stateSchema': None, 'containerUpdate': None,
                          'stateCompatibility': {'diagnostics': 'unversioned-rows-array', 'investigations': 'optional-fingerprint-map'}}}
        catalog = self.make_catalog(); catalog['releases'].append(self.target); self.install_catalog(catalog)
        self.updater.module_volume = lambda *args: {'privateVolume': 'fixture_state'}

    def module_plan(self):
        return self.updater.plan({'planId': str(uuid.uuid4()), 'catalogSha256': self.digest,
                                  'componentId': 'diagnostics', 'versionId': self.version})

    def test_module_plan_start_get_is_installation_only_and_preserves_container_references(self):
        plan = self.module_plan(); self.assertFalse(plan['impact']['containerRestart'])
        identifier = str(uuid.uuid4())
        args = {'requestId': identifier, 'planId': plan['planId'], 'confirmContainerRestart': False}
        self.assertEqual(self.updater.start(args)['admission'], 'accepted')
        self.join()
        self.assertEqual(self.updater.get(identifier)['phase'], 'completed')
        self.assertEqual(self.updater.start(args)['requestId'], identifier)
        self.assertEqual(self.calls, [identifier])
        self.assertFalse((self.prefix / 'state/current.json').exists())
        self.assertEqual(json.loads((self.prefix / 'state/module-current.json').read_text())['current'], identifier)
        self.assertIsNone(self.updater.capabilities()['currentRequestId'])

    def test_module_and_container_share_exclusion_and_active_module_plan_is_not_pruned(self):
        plan = self.module_plan(); self.release.clear()
        self.updater.start({'requestId': str(uuid.uuid4()), 'planId': plan['planId'], 'confirmContainerRestart': False})
        original = time.time()
        with patch.object(module.time, 'time', return_value=original + 301):
            container = self.updater.plan({'planId': str(uuid.uuid4()), 'catalogSha256': self.digest, 'versionId': 'sha256:' + 'e'*64})
        self.assertTrue((self.prefix / 'state/plans' / (plan['planId'] + '.json')).exists())
        with self.assertRaises(module.Failure) as raised:
            self.updater.start({'requestId': str(uuid.uuid4()), 'planId': container['planId'], 'confirmContainerRestart': True})
        self.assertEqual(raised.exception.code, 'HOST_UPDATE_IN_PROGRESS')

    def test_module_requests_refuse_extra_paths_wrong_urls_and_restart_confirmation(self):
        args = {'planId': str(uuid.uuid4()), 'catalogSha256': self.digest, 'componentId': 'diagnostics', 'versionId': self.version}
        for changed in [{**args, 'url': 'https://elsewhere'}, {**args, 'componentId': '../other'}, {**args, 'versionId': '../archive'}]:
            with self.assertRaises(module.Failure): self.updater.plan(changed)
        plan = self.module_plan()
        with self.assertRaises(module.Failure):
            self.updater.start({'requestId': str(uuid.uuid4()), 'planId': plan['planId'], 'confirmContainerRestart': True})
        self.target['artifact']['archive']['url'] = 'https://example.com/archive'
        catalog = self.make_catalog(); catalog['releases'].append(self.target); self.install_catalog(catalog)
        with self.assertRaises(module.Failure): self.module_plan()
        self.assertEqual(self.calls, [])

    def fake_opener(self, corrupt=False):
        outer = self
        class Response(io.BytesIO):
            status = 200
        class Opener:
            def open(self, request, timeout):
                outer.assertEqual(timeout, 15)
                data = outer.bundle if request.full_url.endswith('.sigstore.json') else outer.archive
                return Response(data + b'bad' if corrupt else data)
        return Opener()

    def test_download_validates_exact_hash_size_and_rejects_redirects_outside_the_publisher(self):
        with patch.object(module, 'publication_opener', return_value=self.fake_opener()):
            result = module.module_inputs(self.updater, self.target)
        self.assertEqual((result / 'archive.tar.gz').read_bytes(), self.archive)
        (result / 'archive.tar.gz').chmod(0o600); (result / 'archive.tar.gz').write_bytes(b'changed')
        with self.assertRaises(module.Failure): module.module_inputs(self.updater, self.target)
        import shutil
        shutil.rmtree(result)
        with patch.object(module, 'publication_opener', return_value=self.fake_opener(corrupt=True)):
            with self.assertRaises(module.Failure): module.module_inputs(self.updater, self.target)
        self.assertFalse(result.exists())
        redirect = next(item for item in module.publication_opener().handlers if isinstance(item, urllib.request.HTTPRedirectHandler))
        for url in ['http://github.com/a', 'https://127.0.0.1/a', 'https://user@github.com/a', 'https://github.com:444/a', 'file:///tmp/a']:
            with self.assertRaises(module.Failure):
                redirect.redirect_request(urllib.request.Request('https://github.com/a'), None, 302, 'found', {}, url)

    def test_installer_uses_only_fixed_privileges_same_image_private_volume_and_readonly_input(self):
        plan = self.module_plan(); directory = self.prefix / 'state/operations' / str(uuid.uuid4()); directory.mkdir()
        module.atomic(directory / 'module-volume.json', {'privateVolume': 'fixture_state'})
        commands = []
        def command(args, **options):
            commands.append(args)
            source = next(args[i + 1] for i, value in enumerate(args[:-1]) if value == '--mount').split('source=', 1)[1].split(',target=', 1)[0]
            self.assertEqual((Path(source) / self.version / 'archive.tar.gz').read_bytes(), self.archive)
            self.assertEqual((Path(source) / self.version / 'bundle.json').read_bytes(), self.bundle)
            return json.dumps({'installed': True, 'versionId': self.version}).encode()
        self.config['docker'] = '/fixture/docker'; self.updater.command = command
        with patch.object(module, 'publication_opener', return_value=self.fake_opener()):
            result = module.execute_module_installer(self.updater, plan, directory)
        self.assertEqual(result['verification'], 'succeeded')
        args = commands[0]
        self.assertEqual(args[:3], ['/fixture/docker', 'run', '--rm'])
        self.assertIn(self.current['imageId'], args); self.assertIn('none', args)
        self.assertIn('/app/scripts/install-diagnostics-release.py', args)
        mounts = [args[i + 1] for i, value in enumerate(args[:-1]) if value == '--mount']
        self.assertEqual(len(mounts), 2)
        self.assertIn('readonly', mounts[0]); self.assertIn(str(self.prefix / 'state/module-incoming'), mounts[0])
        self.assertEqual(mounts[1], 'type=volume,source=fixture_state,target=/srv/bellteam-private,volume-nocopy')
        self.assertNotIn('stop', args); self.assertNotIn('restart', args); self.assertNotIn('docker.sock', ' '.join(args))

    def test_metadata_preflight_does_not_pass_server_environment_or_trust_a_foreign_volume(self):
        installation = self.prefix / 'installation'; installation.mkdir()
        normal = {'services': {'bellteam': {'volumes': [], 'environment': {'SECRET': 'never-copy', 'AITERM_STATE_BASE': '/srv/bellteam-aiterm'}}}, 'volumes': {}}
        module.atomic(installation / 'normal.json', normal)
        directory = self.prefix / 'state/operations' / str(uuid.uuid4()); directory.mkdir()
        module.atomic(directory / 'operation.json', {'target': self.target})
        self.config['docker'] = '/fixture/docker'
        self.updater.storage_metadata = lambda *args: {'mounts': [{'Destination': '/run/bellteam-maintenance', 'Type': 'volume', 'Name': 'fixture_state', 'RW': False}], 'specs': []}
        def command(args, **options):
            if args[1] == 'container': return json.dumps({'id': self.current['containerId'], 'image': self.current['imageId']}).encode()
            self.assertIn('--interactive', args[:args.index(self.current['imageId'])])
            raw = options['input']; self.assertNotIn(b'never-copy', raw); self.assertNotIn(b'SECRET', raw)
            self.assertIn(b'AITERM_STATE_BASE', raw)
            return b'{"privateVolume":"fixture_state"}'
        self.updater.command = command
        self.assertEqual(module.HostUpdater.module_volume(self.updater, self.current, directory), {'privateVolume': 'fixture_state'})
        self.updater.command = lambda args, **options: command(args, **options) if args[1] == 'container' else b'{"privateVolume":"foreign"}'
        with self.assertRaises(module.Failure): module.HostUpdater.module_volume(self.updater, self.current, directory)

    def test_installer_timeout_stays_unknown_and_same_uuid_never_runs_the_helper_again(self):
        self.config['docker'] = '/fixture/docker'; self.updater.execute = self.updater.install
        calls = []
        def command(args, **options):
            calls.append(args); raise subprocess.TimeoutExpired(args[0], 300)
        self.updater.command = command
        plan = self.module_plan(); identifier = str(uuid.uuid4())
        args = {'requestId': identifier, 'planId': plan['planId'], 'confirmContainerRestart': False}
        with patch.object(module, 'publication_opener', return_value=self.fake_opener()):
            self.updater.start(args); self.join()
        self.assertEqual(self.updater.get(identifier)['phase'], 'unknown')
        self.updater.start(args)
        self.assertEqual(len(calls), 1)


if __name__ == '__main__': unittest.main()
