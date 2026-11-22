import importlib.util
import json
import os
import shutil
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import PropertyMock, patch

spec = importlib.util.spec_from_file_location('emergency_body', Path(__file__).parents[1] / 'scripts/emergency-body.py')
emergency = importlib.util.module_from_spec(spec)
spec.loader.exec_module(emergency)
service, host = emergency.service, emergency.host

OLD, NEW, TARGET = '1' * 64, '2' * 64, 'sha256:' + 'f' * 64
PUBLISHED = 'ghcr.io/kitepon/bellteam-server@sha256:' + 'e' * 64
INSTALL = '''#!/bin/sh
set -eu
%s
saved="$BELLTEAM_INSTALL_DIR/.bellteam-compose.ABC123"
mkdir "$saved"
cp "$COMPOSE_FILE" "$saved/normal.json"
cp "$BELLTEAM_PREVIOUS_COMPOSE" "$saved/previous-normal.json"
cp "$(dirname "$BELLTEAM_PREVIOUS_COMPOSE")/previous-runtime.json" "$saved/previous-runtime.json"
printf 'saved-compose=%%s\\n' "$saved"
touch "$BELLTEAM_INSTALL_DIR/applied"
'''


class EmergencyBodyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=Path(__file__).parents[1])
        self.addCleanup(self.temporary.cleanup)
        self.prefix = Path(self.temporary.name)
        (self.prefix / 'state').mkdir(mode=0o700)
        (self.prefix / 'installation').mkdir()
        self.release = self.prefix / 'image'; (self.release / 'scripts').mkdir(parents=True)
        (self.release / 'scripts/cleanup-deploy-images.py').write_text('# mocked cleanup')
        self.install = self.prefix / 'work'; self.install.mkdir()
        self.config = dict(projectName='fixed-project', workerImage='sha256:' + 'a' * 64, volumeName='fixed-project-container-updater',
                           volumeRoot=str(self.prefix), installRoot=str(self.install), release='b' * 40,
                           platform=dict(os='linux', arch='amd64'), docker=service.DOCKER, python=sys.executable, shell='/bin/sh')
        host.atomic(self.prefix / 'installation/normal.json', dict(name='fixed-project', services=dict(bellteam=dict(image='sha256:' + 'a' * 64))))
        self.updater = emergency.EmergencyUpdater(self.prefix, self.config, uid=os.getuid())
        self.updater.assert_model_binding = lambda *_args, **_: None
        self.calls = []
        self.status = 'exited'
        self.busy = ''
        self.own = TARGET
        self.updater.storage_metadata = lambda _id: dict(mounts=[], specs=[])
        self.updater.command = self.command

    def command(self, args, **options):
        self.calls.append(args)
        if args[1] == 'ps' and '-a' in args: return (NEW if (self.install / 'applied').exists() else OLD).encode()
        if args[1] == 'ps': return self.busy.encode()
        if args[1:3] == ['container', 'inspect']:
            return json.dumps(dict(image='sha256:' + 'a' * 64, running=False, restarting=self.status == 'restarting', status=self.status)).encode()
        if args[1:3] == ['image', 'inspect'] and 'org.opencontainers.image.revision' in args[4]: return b'c' * 40
        if args[1:3] == ['image', 'inspect']: return (self.own if args[-1] in (TARGET, PUBLISHED) else TARGET).encode()
        return b''

    def run_swap(self, install_script, reference=TARGET, local=True, healthy=True):
        (self.release / 'install.sh').write_text(install_script)
        def strict(updater):
            return dict(storageBinding='x', containerId=NEW, imageId=TARGET, sourceCommit='e' * 40,
                        health='healthy' if healthy else 'unhealthy', imageRef=None)
        # File trust (root-owned inputs) is the installer's own, already tested check; the fixture tree belongs to the test user.
        with patch.object(service.ContainerUpdater, 'code_root', new_callable=PropertyMock, return_value=self.release), \
             patch.object(service.ContainerUpdater, 'inspect_current', strict), patch.object(host, 'trusted', lambda *_a, **_k: None):
            return emergency.emergency(self.updater, reference, local, 'e' * 40, TARGET)

    def test_reference_forms_and_local_rule(self):
        self.assertEqual(emergency.parse([PUBLISHED]), (PUBLISHED, False))
        self.assertEqual(emergency.parse(['--local', TARGET]), (TARGET, True))
        for bad in ([], [TARGET], ['--local', PUBLISHED], ['ghcr.io/other/x@sha256:' + 'e' * 64], ['latest'], [PUBLISHED, PUBLISHED]):
            with self.assertRaises(host.Failure, msg=bad) as caught: emergency.parse(bad)
            self.assertEqual(caught.exception.code, 'EMERGENCY_REFERENCE_INVALID')

    def test_refuses_a_running_image_that_is_not_the_reference_and_a_running_update_worker(self):
        self.own = 'sha256:' + '9' * 64
        with self.assertRaises(host.Failure) as caught: emergency.emergency(self.updater, TARGET, True, 'e' * 40, TARGET)
        self.assertEqual(caught.exception.code, 'EMERGENCY_IMAGE_MISMATCH')
        self.own = TARGET; self.busy = 'f' * 12
        with self.assertRaises(host.Failure) as caught: emergency.emergency(self.updater, TARGET, True, 'e' * 40, TARGET)
        self.assertEqual(caught.exception.code, 'EMERGENCY_UPDATE_RUNNING')
        self.assertEqual(list((self.prefix / 'state/operations').glob('*')), [])  # refused before anything was created

    def test_swaps_in_a_local_body_when_the_old_body_is_down_without_pull_or_queue(self):
        for status in ('exited', 'restarting'):
            with self.subTest(status=status):
                self.status = status; self.calls.clear()
                (self.install / 'applied').unlink(missing_ok=True); shutil.rmtree(self.install / '.bellteam-compose.ABC123', ignore_errors=True)
                outcome = self.run_swap(INSTALL % '')
                self.assertEqual(outcome['result']['verification'], 'succeeded', outcome)
                self.assertEqual(outcome['previous'], {'state': status})
                self.assertFalse([call for call in self.calls if 'pull' in call])
                self.assertFalse([call for call in self.calls if 'exec' in call])  # nothing is asked of the old body
                saved = host.read_json(self.prefix / 'installation/normal.json', os.getuid())
                self.assertEqual(saved['services']['bellteam']['image'], TARGET)
                runtime = host.read_json(next((self.prefix / 'installation/operations').glob('*/previous-runtime.json')), os.getuid())
                self.assertEqual(runtime, {'Id': OLD, 'Image': 'sha256:' + 'a' * 64})

    def test_a_published_reference_is_pulled_and_a_body_that_is_not_healthy_fails_verification(self):
        outcome = self.run_swap(INSTALL % '', reference=PUBLISHED, local=False, healthy=False)
        self.assertEqual(outcome['result']['verification'], 'failed')
        self.assertTrue([call for call in self.calls if call[1:3] == ['pull', PUBLISHED]])

    def test_installer_failure_is_reported_and_exit_code_follows_verification(self):
        outcome = self.run_swap(INSTALL % 'exit 3')
        self.assertEqual(outcome['result']['error'], 'HOST_UPDATE_INSTALL_FAILED')
        self.assertEqual(outcome['result']['rollback'], 'unavailable')
        with patch.object(emergency, 'emergency', return_value=outcome), patch.object(service, 'load', return_value=self.updater), \
             patch.object(service, 'distribution', return_value=('e' * 40, {})):
            self.updater.command = lambda *_a, **_k: TARGET.encode()
            self.assertEqual(emergency.main(['--local', TARGET]), 1)
        with patch.object(emergency, 'emergency', return_value={'result': {'verification': 'succeeded'}}), patch.object(service, 'load', return_value=self.updater), \
             patch.object(service, 'distribution', return_value=('e' * 40, {})):
            self.updater.command = lambda *_a, **_k: TARGET.encode()
            self.assertEqual(emergency.main(['--local', TARGET]), 0)

    def test_old_body_snapshot_is_stable_while_that_container_exists_and_strict_afterwards(self):
        first, _ = self.updater.snapshot_old()
        self.assertEqual(self.updater.inspect_current(), first)
        self.status = 'restarting'
        self.assertEqual(self.updater.inspect_current(), first)
        self.assertEqual(first['sourceCommit'], 'c' * 40)
        with patch.object(service.ContainerUpdater, 'inspect_current', lambda updater: 'strict'):
            (self.install / 'applied').write_text('')
            self.assertEqual(self.updater.inspect_current(), 'strict')


class WrapperTests(unittest.TestCase):
    def run_wrapper(self, *args, env=None):
        import subprocess
        with tempfile.TemporaryDirectory() as directory:
            fake = Path(directory) / 'docker'
            fake.write_text('#!/bin/sh\n'
                            'case "$1 $2" in "volume inspect") echo /var/lib/docker/volumes/p-container-updater/_data;; '
                            '"image inspect") echo sha256:' + 'f' * 64 + ';; esac\n'
                            'printf "%s\\n" "$*" >> ' + directory + '/calls\n')
            fake.chmod(0o755)
            run = subprocess.run(['/bin/sh', str(Path(__file__).parents[1] / 'distribution/server/emergency-body.sh'), *args],
                                 env={'PATH': directory + ':/usr/bin:/bin', **(env or {})}, capture_output=True, text=True)
            calls = (Path(directory) / 'calls').read_text().splitlines() if (Path(directory) / 'calls').exists() else []
            return run, calls

    def test_published_reference_is_pulled_and_the_target_image_runs_the_entry_with_the_worker_layout(self):
        run, calls = self.run_wrapper(PUBLISHED, env={'BELLTEAM_PROJECT': 'p'})
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(calls[0], 'pull ' + PUBLISHED)
        launch = calls[-1]
        self.assertIn('--user 0:0 --cap-drop ALL', launch); self.assertIn('--read-only', launch)
        self.assertIn('source=p-container-updater,target=/srv/bellteam-container-updater', launch)
        self.assertIn('target=/var/lib/docker/volumes/p-container-updater/_data', launch)
        self.assertIn('source=/var/run/docker.sock', launch)
        self.assertTrue(launch.endswith('--entrypoint /usr/bin/python3 ' + PUBLISHED + ' -I -B /app/scripts/emergency-body.py ' + PUBLISHED))

    def test_local_uses_the_image_id_and_bad_input_is_refused_before_docker(self):
        run, calls = self.run_wrapper('--local', 'bellteam-local')
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertTrue(calls[-1].endswith('/app/scripts/emergency-body.py --local ' + TARGET))
        for args in ([], ['ghcr.io/other/x@sha256:abc'], ['a', 'b']):
            run, calls = self.run_wrapper(*args)
            self.assertEqual(run.returncode, 2); self.assertEqual(calls, [])
        run, calls = self.run_wrapper(PUBLISHED, env={'BELLTEAM_PROJECT': 'a b'})
        self.assertEqual(run.returncode, 2); self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
