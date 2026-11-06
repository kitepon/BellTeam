import importlib.util
import os
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location('service', Path(__file__).parents[1] / 'scripts/module-update-service.py')
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)
host = service.host


class BundledModuleTests(unittest.TestCase):
    @unittest.skipIf(os.getuid() == 0, 'Non-root entry rejection only')
    def test_entry_rejects_non_root_with_fixed_diagnostic(self):
        result = subprocess.run([sys.executable, '-I', '-B', service.__file__], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, 'HOST_UPDATE_ROOT_REQUIRED\n')
        self.assertEqual(result.stdout, '')

    def test_shared_ledger_claim_and_namespace_loss_do_not_reexecute(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parents[1]) as directory:
            prefix = Path(directory)
            (prefix / 'state').mkdir(mode=0o700)
            config = {'release': 'a' * 40, 'platform': {'os': 'linux', 'arch': 'amd64'}}
            current = {'sourceCommit': config['release'], 'privateVolume': {'device': '1', 'inode': '2'}}
            calls = []
            updater = service.ModuleUpdater(prefix, prefix, config, uid=os.getuid(), inspect=lambda: current,
                execute=lambda *_args: calls.append('install') or dict(execution='succeeded', verification='succeeded',
                    cleanup='succeeded', rollback='not_needed', observed=current, error=None))
            updater.assert_model_binding = lambda observed: self.assertEqual(observed, current)
            updater.module_volume = lambda *_args: current['privateVolume']
            target = {'componentId': 'usage', 'versionId': 'b' * 64}
            updater.planned_target = lambda plan: target
            plan_id, request_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
            host.atomic(updater.state / 'plans' / (plan_id + '.json'), dict(planId=plan_id, catalogSha256='a'*64, target=target,
                expected=current, expiresAt='2099-01-01T00:00:00+00:00', impact={'containerRestart': False}))
            updater.launcher = updater.worker  # Finite protocol fixture, no root/real installer claim.
            params = dict(requestId=request_id, planId=plan_id, confirmContainerRestart=False)
            result = updater.start(params)
            self.assertEqual(result['phase'], 'completed')
            self.assertEqual(updater.start(params), result)
            self.assertEqual(calls, ['install'])
            record = updater.read_operation(request_id)
            self.assertIn('pidNamespace', record['worker'])
            self.assertNotIn('unit', record['worker'])
            record.update(phase='applying', worker={**record['worker'], 'pidNamespace': 'different'})
            host.atomic(updater.state / 'operations' / request_id / 'operation.json', record)
            self.assertEqual(updater.get(request_id)['phase'], 'failed')
            self.assertEqual(calls, ['install'])
            with patch.object(host.HostUpdater, 'capabilities', return_value=dict(supported=True, reason=None, moduleInstallProtocol=1)):
                capability = updater.capabilities()
            self.assertFalse(capability['supported'])
            self.assertTrue(capability['moduleInstallSupported'])
            with self.assertRaises(host.Failure): updater.target('unused', 'unused')

    def test_image_worker_and_existing_signed_installer_are_the_only_execution_paths(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parents[1]) as directory:
            prefix = Path(directory)
            (prefix / 'state').mkdir(mode=0o700)
            updater = service.ModuleUpdater(prefix, prefix, {'release': 'a' * 40, 'platform': {'os': 'linux', 'arch': 'amd64'}}, uid=os.getuid())
            request_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
            with patch.object(service.subprocess, 'Popen') as launch:
                updater.launch_service(request_id)
                args, kwargs = launch.call_args
                self.assertEqual(args[0], ['/usr/bin/python3', '-I', '-B', str(Path(service.__file__).absolute()), '--worker', request_id])
                self.assertTrue(kwargs['start_new_session'])
                self.assertNotIn('DOCKER_HOST', kwargs['env'])
            incoming = prefix / 'usage' / ('b' * 64)
            incoming.mkdir(parents=True)
            target = dict(componentId='usage', versionId='b' * 64, sourceCommit='a' * 40, artifact={'signerCommit': 'c' * 40})
            plan = {'target': target, 'expected': {'binding': 'actual fixture'}}
            updater.planned_target = lambda _plan: target
            updater.assert_model_binding = Mock()
            updater.inspect_current = lambda: plan['expected']
            updater.progress = lambda *_: None  # This fixture calls the installer directly, outside job admission.
            installer = Mock()
            installer.expectation.return_value = {'archiveSha256': target['versionId']}
            installer.install.return_value = dict(versionId=target['versionId'], installed=True)
            with patch.object(host, 'module_inputs', return_value=incoming), patch.object(service, 'load_module', return_value=installer):
                result = updater.install(plan, prefix)
            installer.install.assert_called_once_with(prefix, incoming.parent, installer.expectation.return_value, 'usage')
            self.assertEqual(result['verification'], 'succeeded')
            self.assertFalse(incoming.exists())


if __name__ == '__main__': unittest.main()
