import importlib.util
import hashlib
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('generation_fixture', ROOT / 'test/sec014-control-generation.py')
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)


class HeldWriterConfig(g.Generations):
    def pair(self):
        normal = self.normal('aaaaaa')
        model = json.loads(normal.read_text())
        service = model['services']['bellteam']
        service['environment']['SECRET'] = 'synthetic-credential'
        bind = lambda source, target: {'type': 'bind', 'source': str(source), 'target': target}
        legacy, home = self.root / 'legacy', self.root / 'home'
        service['volumes'] += [bind(legacy, '/srv/bellteam'), bind(home, '/home/bell'),
                               {'type': 'volume', 'source': 'cursor', 'target': '/home/bell/.local'}]
        model['volumes'] = {'cursor': {'name': 'fixture_cursor', 'driver_opts': {'SECRET': 'synthetic-credential'}}}
        normal.write_text(json.dumps(model))
        leaves = ['state', 'rooms', 'owner', 'logs', 'shared/tools/bellteam-settings', 'shared/tools/apns']
        maintenance = normal.parent / 'compose.state-maintenance.json'
        maintenance.write_text(json.dumps({'services': {'state-maintenance': {
            'image': g.SELECTED['image'], 'environment': {'SECRET': 'synthetic-credential'},
            'volumes': [bind(legacy, '/srv/bellteam-legacy'), bind(legacy, '/srv/bellteam'),
                        *[bind(self.root / 'private' / leaf, '/srv/bellteam/' + leaf) for leaf in leaves],
                        bind(self.root / 'backups', '/srv/bellteam-maintenance-backups')]}}}))
        maintenance.chmod(0o600)
        return normal, maintenance

    def test_factory_projects_held_models_into_existing_node_planner(self):
        normal, maintenance = self.pair()
        seen = []
        def factory(tx):
            self.assertTrue(callable(getattr(tx, '_writer_config', None)))
            config = tx._writer_config()
            for role in ('bellteam', 'state-maintenance'):
                self.assertEqual(config['services'][role]['image'], g.SELECTED['image'])
            raw = json.dumps(config)
            for secret in ['synthetic-credential', 'SECRET', g.SELECTED['token'], 'environment', 'driver_opts']:
                self.assertNotIn(secret, raw)
            self.assertEqual(tx.value['normal']['maintenance']['inode'], maintenance.stat().st_ino)
            module = (ROOT / 'distribution/internal/sec014-writer-snapshot.mjs').as_uri()
            program = '''
import {createHash} from 'node:crypto';
import {writerSnapshotPlan,verifyWriterSnapshot} from MODULE;
const chunks=[];for await(const c of process.stdin)chunks.push(c);
const config=JSON.parse(Buffer.concat(chunks)),plan=writerSnapshotPlan(config,IMAGE,IMAGE_ID);
const rawUtf8='',list={argv:plan.listArgv,clientPid:123,clientStartTicks:456,unknown:false,
 terminal:{kind:'exit',code:0},rawUtf8,stdoutBytes:0,stdoutSha256:createHash('sha256').update(rawUtf8).digest('hex')};
const observation=verifyWriterSnapshot(plan,{list,containers:null,volumes:[],
 canonical:plan.mounts.roots.map(source=>({source,canonical:source}))});
console.log(JSON.stringify({plan,observation}));
'''.replace('MODULE', json.dumps(module)).replace('IMAGE_ID', json.dumps(g.SELECTED['image'])).replace('IMAGE,', json.dumps(g.IMAGE) + ',')
            result = subprocess.run(['node', '--input-type=module', '-e', program], input=raw,
                                    text=True, capture_output=True, timeout=5, check=True)
            output = json.loads(result.stdout)
            self.assertIn(str(self.root / 'private' / 'state'), output['plan']['mounts']['roots'])
            self.assertIn(str(self.root / 'backups'), output['plan']['mounts']['roots'])
            self.assertEqual(output['plan']['mounts']['volume'], 'fixture_cursor')
            self.assertFalse(output['observation']['hostWriterAuthorityVerified'])
            self.assertFalse(output['observation']['phaseReceiptProduced'])
            keys = ('path', 'sha256', 'device', 'inode', 'parentDevice', 'parentInode')
            print('WRITER_NODE_OUTPUT ' + json.dumps({
                'producer': 'local Node planner; synthetic Docker terminal bundle',
                'inputSha256': hashlib.sha256(raw.encode()).hexdigest(), 'config': config,
                'binding': {role: {key: record[key] for key in keys} for role, record in (
                    ('normal', tx.value['normal']), ('maintenance', tx.value['normal']['maintenance']))},
                'nodeTerminal': {'kind': 'exit', 'code': result.returncode}, 'output': output}), flush=True)
            seen.append(tx)
            raise RuntimeError('STOP_METADATA_ONLY')
        with patch.object(g.c, 'host_control', side_effect=lambda direction, saved_normal: self.hold(saved_normal)):
            with self.assertRaisesRegex(RuntimeError, 'STOP_METADATA_ONLY'):
                g.a.run_actor('to-server', g.IMAGE, factory, saved_normal=normal)
        self.assertEqual(len(seen), 1)
        journal = json.loads((self.control / 'transaction-to-server.json').read_text())
        self.assertEqual(journal['phases'], [])
        self.assertEqual(journal['status'], 'incomplete')

    def test_replaced_maintenance_is_rejected_before_projection(self):
        normal, maintenance = self.pair()
        with self.hold(normal) as tx:
            self.assertTrue(callable(getattr(tx, '_writer_config', None)))
            replacement = maintenance.with_suffix('.replacement')
            replacement.write_bytes(maintenance.read_bytes())
            replacement.chmod(0o600)
            os.replace(replacement, maintenance)
            with self.assertRaises(g.c.ControlError):
                tx._writer_config()

    def test_non_scalar_mount_source_cannot_leave_projection(self):
        normal, maintenance = self.pair()
        model = json.loads(maintenance.read_text())
        model['services']['state-maintenance']['volumes'][0]['source'] = {'SECRET': 'synthetic-credential'}
        maintenance.write_text(json.dumps(model))
        with self.hold(normal) as tx:
            self.assertTrue(callable(getattr(tx, '_writer_config', None)))
            with self.assertRaises(g.c.ControlError):
                tx._writer_config()


if __name__ == '__main__':
    names = [name for name in HeldWriterConfig.__dict__ if name.startswith('test_')]
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(HeldWriterConfig(name) for name in names))
    raise SystemExit(not result.wasSuccessful())
