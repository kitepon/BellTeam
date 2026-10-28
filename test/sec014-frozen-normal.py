import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
root = Path(os.environ.get('SEC014_FROZEN_SOURCE', Path(__file__).resolve().parents[1]))
spec = importlib.util.spec_from_file_location('frozen_actor', root/'distribution/internal/sec014-host-actor.py')
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
c = a.control
RAW = 'sha256:' + 'a'*64
IMAGE = 'ghcr.io/kitepon/bellteam-server@sha256:' + 'b'*64
TOKEN = 'c'*64
SELECTED = {'container_id': 'd'*64, 'image': RAW, 'token': TOKEN}


class FrozenNormal(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.counter = 0

    def model(self):
        return {'name': 'bellteam', 'services': {'bellteam': {'image': RAW,
            'environment': {'BELLTEAM_NORMAL_ADMISSION_TOKEN': TOKEN},
            'volumes': [{'type': 'bind', 'source': str(c.CONTROL),
                'target': '/run/bellteam-maintenance', 'read_only': True,
                'bind': {'create_host_path': False}}]}}}

    def hold(self, model):
        self.counter += 1
        generation = self.root/('.bellteam-compose.' + f'{self.counter:06d}')
        generation.mkdir(mode=0o700)
        normal = generation/'normal.json'
        normal.write_text(json.dumps(model)); normal.chmod(0o600)
        control = self.root/('control' + str(self.counter))
        control.mkdir(mode=0o750); control.chmod(0o750)
        return c._hold(control, 'to-server', (os.getuid(), os.getgid()),
            normal_group=os.getgid(), saved_normal=normal)

    def phases(self, tx):
        for phase in c.PHASES[:4]: tx.confirmed(phase)

    def test_missing_token_or_nonreadonly_nonfixed_mount_is_refused_before_journal(self):
        variants = []
        missing = self.model(); missing['services']['bellteam']['environment'] = {}; variants.append(missing)
        for key, value in [('read_only', False), ('source', '/other/control')]:
            model = self.model(); model['services']['bellteam']['volumes'][0][key] = value; variants.append(model)
        model = self.model(); model['services']['bellteam']['volumes'][0]['bind']['create_host_path'] = True; variants.append(model)
        model = self.model(); model['services']['bellteam']['volumes'].append(dict(model['services']['bellteam']['volumes'][0])); variants.append(model)
        for model in variants:
            with self.subTest(model=model):
                with self.assertRaisesRegex(c.ControlError, 'GENERATION'):
                    with self.hold(model): pass
                self.assertFalse((self.root/('control'+str(self.counter))/'transaction-to-server.json').exists())

    def test_selection_must_match_saved_raw_image_and_token_without_releasing_ex(self):
        for key, value in [('image', 'sha256:'+'e'*64), ('token', 'f'*64)]:
            with self.subTest(key=key), self.hold(self.model()) as tx:
                self.phases(tx)
                with self.assertRaisesRegex(c.ControlError, 'HANDOFF_SELECTION'):
                    tx.admit_normal(**dict(SELECTED, **{key: value}))
                self.assertIsNone(tx.value['admission'])
                self.assertFalse(tx.shared)
                normal = os.open(tx.path/'sec014.lock', os.O_RDONLY)
                try:
                    with self.assertRaises(BlockingIOError): fcntl.flock(normal, fcntl.LOCK_SH | fcntl.LOCK_NB)
                finally: os.close(normal)

    def executor(self, tx, calls, selected=SELECTED):
        case = self
        class Executor:
            def prepare_selected_normal(self, **fields):
                case.assertEqual(fields.get('saved_normal'), tx.value['normal'])
                calls.append('select')
                return dict(selected)

            def __getattr__(self, name):
                index = ('assert_writers_stopped', 'prepare', 'backup_and_migrate',
                    'assert_binds', 'start_selected_normal', 'verify_result').index(name)
                def run(**fields):
                    if index >= 4:
                        case.assertEqual(fields.get('saved_normal'), tx.value['normal'])
                        case.assertEqual(fields['selected_normal'], tx.value['admission'])
                    calls.append(name)
                    return dict(schema='bellteam.sec014.phase-receipt.v1', direction=fields['direction'],
                        phase=c.PHASES[index], image=fields['image'], actorPid=fields['actor_pid'],
                        actorStartTicks=fields['actor_start_ticks'], status='verified',
                        proofs={key: 'a'*64 for key in a.PROOFS[index]})
                return run
        return Executor()

    def test_same_frozen_generation_reaches_select_start_and_result(self):
        with self.hold(self.model()) as tx:
            raw = Path(tx.value['normal']['path']).read_bytes()
            self.assertEqual(tx.value['normal']['sha256'], hashlib.sha256(raw).hexdigest())
            calls = []
            a._run(tx, IMAGE, self.executor(tx, calls))
            self.assertEqual(calls[-3:], ['select', 'start_selected_normal', 'verify_result'])
            self.assertEqual(tx.value['status'], 'completed')

    def test_actor_never_starts_mismatching_selected_normal(self):
        with self.hold(self.model()) as tx:
            calls = []
            with self.assertRaisesRegex(c.ControlError, 'HANDOFF_SELECTION'):
                a._run(tx, IMAGE, self.executor(tx, calls, dict(SELECTED, token='e'*64)))
            self.assertNotIn('start_selected_normal', calls)
            self.assertEqual(tx.value['phases'], list(c.PHASES[:4]))

    def test_internal_freeze_checks_the_token_that_was_selected_before_render(self):
        script = (root/'scripts/deploy-image.sh').read_text()
        code = script.split('const fs=require("node:fs"), path=require("node:path");', 1)[1].split("\n' \"$image\"", 1)[0]
        code = 'const fs=require("node:fs"), path=require("node:path");' + code
        prepare = {'services': {'state-prepare': {'image': RAW, 'volumes': [{'source': '/private', 'target': '/srv/bellteam-state-parent'}]}}}
        maintenance = {'services': {'state-maintenance': {'image': RAW, 'volumes': [{'source': '/private/state', 'target': '/srv/bellteam/state'}]}}}
        for token, ok in [(TOKEN, True), ('e'*64, False)]:
            with self.subTest(token=token):
                result = subprocess.run(['node', '-e', code, RAW, '/retained/.bellteam-compose.123456', token],
                    input=json.dumps([self.model(), prepare, maintenance]), text=True, capture_output=True)
                self.assertEqual(result.returncode == 0, ok, result.stderr)
                if ok:
                    frozen = json.loads(result.stdout.splitlines()[1])
                    self.assertEqual(frozen['services']['bellteam']['environment']['BELLTEAM_NORMAL_ADMISSION_TOKEN'], TOKEN)

    def test_internal_dispatch_generates_fresh_token_before_any_compose_effect(self):
        script = (root/'scripts/deploy-image.sh').read_text()
        prefix = script.split('# 旧本体の実imageを控える。', 1)[0]
        prefix = prefix.replace('cd "$(dirname "$0")/.."', 'cd "$FIXTURE_ROOT"')
        result = subprocess.run(['sh', '-c', prefix + '\nnode -e "console.log(process.env.BELLTEAM_NORMAL_ADMISSION_TOKEN || \'\')"\n'],
            text=True, capture_output=True, env={**os.environ, 'FIXTURE_ROOT': str(self.root),
                'BELLTEAM_SERVER_IMAGE': '', 'BELLTEAM_NORMAL_ADMISSION_TOKEN': 'inherited-invalid'})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout.splitlines()[0], r'^[a-f0-9]{64}$')


if __name__ == '__main__': unittest.main(verbosity=2)
