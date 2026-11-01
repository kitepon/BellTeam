import importlib.util
import json
import os
import subprocess
import time
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('forward_saved_fixture', ROOT/'test/sec014-saved-prepare.py')
saved = importlib.util.module_from_spec(spec)
spec.loader.exec_module(saved)
spec = importlib.util.spec_from_file_location('forward_actor', ROOT/'distribution/internal/sec014-host-actor.py')
actor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(actor)


class Forward(saved.SavedPrepare):
    def test_unprivileged_forward_refuses_before_any_native_command(self):
        if os.getuid() == 0:
            self.skipTest('ordinary-user boundary fixture')
        maintenance = self.normal.parent/'compose.state-maintenance.json'
        model=json.loads((ROOT/'compose.state-maintenance.json').read_bytes())
        model['services']['state-maintenance'].update(image=saved.old.IMAGE_ID,mem_limit=2147483648,memswap_limit=2147483648)
        maintenance.write_text(json.dumps(model))
        maintenance.chmod(0o600)
        normal=json.loads(self.normal.read_bytes());normal['services']['bellteam']['read_only']=True
        self.normal.write_text(json.dumps(normal))
        with self.f.hold() as tx, patch.object(actor.subprocess, 'Popen', side_effect=AssertionError('native command before root validation')):
            with self.assertRaisesRegex(actor.control.ControlError, 'ROOT_REQUIRED'):
                actor._InternalForward(tx, 'c'*64)
            self.assertEqual(tx._native_children, [])
            self.assertEqual(tx.value['phases'], [])


# The host policy is an explicit ordinary-user seam; Docker application replies
# are synthetic, while Node verification, child processes, saves and locks are real.
class Pipeline(saved.SavedPrepare):
    def setUp(self):
        super().setUp()
        self.g.control.rmdir()
        (self.g.root/'private').mkdir(mode=0o700)
        self.g.control=self.g.root/'private/control';self.g.control.mkdir(mode=0o750);self.g.control.chmod(0o750)
        self.f.root=self.g.control
        self.fake_commands = []
        self.created = False
        self.started = False
        self.prepared_live = False
        self.maintenance_live = False
        self.mutation = None
        self.old_id, self.selected_id, self.maintenance_id = 'a'*64, 'd'*64, 'e'*64
        self.data = self.g.root/'data'; self.data.mkdir()
        self.home = self.g.root/'home'; self.home.mkdir()
        self.volume = self.g.root/'cursor'; self.volume.mkdir()
        self.backups = self.g.root/'backups'; self.backups.mkdir(mode=0o700)
        for module in (actor.control, saved.generation.c):
            stub = patch.object(module, 'CONTROL', self.g.control)
            stub.start(); self.addCleanup(stub.stop)
        model = json.loads(self.normal.read_text())
        service = model['services']['bellteam']
        service.update(read_only=True, tmpfs=['/tmp:rw,nosuid,nodev,size=64m'])
        service['volumes'][0]['source'] = str(self.g.control)
        service['volumes'] += [dict(type='bind',source=str(self.data),target='/srv/bellteam'),
            dict(type='bind',source=str(self.home),target='/home/bell'),
            dict(type='volume',source='cursor',target='/home/bell/.local')]
        for name in actor.prepared.LEAVES:
            target = '/srv/bellteam/'+('shared/tools/'+name if name in ('bellteam-settings','apns') else name)
            service['volumes'].append(dict(type='bind',source=str(self.f.state/name),target=target))
        model['volumes'] = {'cursor': {'name':'fixture_cursor'}}
        self.normal.write_text(json.dumps(model))
        self.normal_model = model
        maintenance = json.loads((ROOT/'compose.state-maintenance.json').read_text())
        m = maintenance['services']['state-maintenance']
        m['image'] = saved.old.IMAGE_ID
        m['mem_limit'] = m['memswap_limit'] = 2147483648
        for volume in m['volumes']:
            target = volume['target']
            volume['source'] = str(self.data if target in ('/srv/bellteam','/srv/bellteam-legacy')
                else self.backups if target == '/srv/bellteam-maintenance-backups'
                else self.f.state/target.rsplit('/',1)[1])
        path = self.normal.parent/'compose.state-maintenance.json'
        path.write_text(json.dumps(maintenance)); path.chmod(0o600)
        self.maintenance_model = maintenance

    def mounts_for(self, role):
        model = self.normal_model if role == 'bellteam' else self.maintenance_model
        return [dict(Type=v['type'], Source=v['source'] if v['type']=='bind' else str(self.volume),
            Destination=v['target'], RW=not v.get('read_only',False),
            **({'Name':'fixture_cursor'} if v['type']=='volume' else {})) for v in model['services'][role]['volumes']]

    def spawn(self, argv, **kwargs):
        if argv[0] != '/usr/bin/docker':
            return self.real_popen(argv, **kwargs)
        import hashlib
        from datetime import datetime, timezone
        self.fake_commands.append(argv)
        if argv[1:3] == ['image','inspect']:
            raw = json.dumps(saved.old.IMAGE_ID)
        elif argv[1:3] == ['container','ls']:
            ids = [] if '--filter' in argv else [self.old_id]+([self.selected_id] if self.created else [])
            raw = '\n'.join(ids)+ ('\n' if ids else '')
        elif argv[1:3] == ['volume','inspect']:
            raw = json.dumps(dict(name='fixture_cursor',driver='local',mountpoint=str(self.volume),
                optionCount=0,type=None,device=None,options=None))
        elif argv[1] == 'inspect' and '--type' not in argv:
            values=[]
            for cid in argv[argv.index('--format')+2:]:
                values.append(dict(id=cid,running=cid==self.selected_id and self.started,restarting=False,
                    restartPolicy='unless-stopped',mounts=self.mounts_for('bellteam')))
            if self.mutation == 'foreign-writer':
                values[0]['running'] = True
            raw = '\n'.join(json.dumps(value) for value in values)+'\n'
        elif argv[1] == 'inspect' and '"imageRef"' in argv[argv.index('--format')+1]:
            if argv[-1].endswith('-prepare'):
                raw = json.dumps(self.inspector())
            else:
                value = self.inspector()
                value.update(id=self.maintenance_id,name='/'+argv[-1],project='bellteam',service='state-maintenance',
                    entrypoint=['/usr/bin/env','-i','PATH=/usr/local/bin:/usr/bin:/bin','/usr/local/bin/node','/app/src/server-state-transfer.mjs'],
                    command=['to-server'],caps=['CHOWN','DAC_OVERRIDE','FOWNER'],mounts=self.mounts_for('state-maintenance'))
                if self.mutation == 'maintenance-image': value['imageId'] = 'sha256:'+'f'*64
                raw = json.dumps(value)
        elif argv[1] == 'inspect':
            cid = argv[-1]
            mounts = self.mounts_for('bellteam')
            if self.mutation == 'selected-mount' and cid == self.selected_id:
                mounts[1]['RW'] = False
            raw = json.dumps(dict(id=cid,image=saved.old.IMAGE_ID,configImage=saved.old.IMAGE_ID,
                state={'Running':cid==self.selected_id and self.started,'Restarting':False,'Pid':self.normal_native.pid if cid==self.selected_id and self.started else 0,'Health':{'Status':'healthy'}},
                user='bellteam-server' if self.mutation=='named-user' else str(os.getuid())+':'+str(os.getgid()),readonly=True,tmpfs={'/tmp':'rw,nosuid,nodev,size=64m'},
                service='bellteam',project='bellteam',mounts=mounts))
        elif argv[1] == 'compose' and argv[-1] == 'state-prepare':
            self.birth = datetime.now(timezone.utc).isoformat()
            self.prepared_live = True
            raw = '{"status":"prepared"}\n'
        elif argv[1] == 'compose' and argv[-2:] == ['state-maintenance','to-server']:
            self.birth=datetime.now(timezone.utc).isoformat()
            value = dict(direction='to-server',status='fresh',ownership={'direction':'to-server'},backups={})
            for view in ('legacy','server'):
                parent=self.backups/view/'before-to-server'; parent.mkdir(parents=True,mode=0o700)
                (self.backups/view).chmod(0o700)
                document=parent/'state/bots/bot-fixture/schedule.json'
                document.parent.mkdir(parents=True)
                document.write_bytes(b'{"schema":"bellteam.schedule.v1","schedules":[]}')
                target=self.f.state/'state/bots/bot-fixture/schedule.json'
                target.parent.mkdir(parents=True,exist_ok=True)
                target.write_bytes(b'changed' if self.mutation=='current-data' else document.read_bytes())
                path=parent/'complete.json'
                marker=json.dumps(dict(schema='bellteam.state-backup.v1',direction='to-server',status='complete')).encode()
                path.write_bytes(marker);path.chmod(0o600);info=path.stat()
                value['backups'][view]=dict(status='created',receipt=dict(
                    path='/srv/bellteam-maintenance-backups/'+view+'/before-to-server/complete.json',
                    device=str(info.st_dev),inode=str(info.st_ino),sha256=hashlib.sha256(marker).hexdigest()))
                if self.mutation=='backup-symlink' and view=='server':
                    original=parent/'original.json';path.rename(original);path.symlink_to(original)
            raw=json.dumps(value)
        elif argv[1]=='rm':
            raw=argv[-1]+'\n'
        elif argv[1]=='compose' and 'create' in argv:
            self.created=True;raw=''
        elif argv[1]=='compose' and 'ps' in argv:
            raw=self.selected_id+'\n'
        elif argv[1]=='start':
            self.normal_native=self.real_popen([sys.executable,'-c','import time;time.sleep(30)'])
            def close_normal():
                self.normal_native.terminate();self.normal_native.wait(timeout=2)
            self.addCleanup(close_normal)
            self.started=True;raw=self.selected_id+'\n'
        elif argv[1]=='exec':
            raw='{"status":200}\n'
        else:
            self.fail('unhandled fixed Docker argv: '+repr(argv))
        program='import sys;sys.stdout.buffer.write(bytes.fromhex('+repr(raw.encode().hex())+'))'
        if self.mutation == 'unknown-child' and argv[-2:] == ['state-maintenance','to-server']:
            self.driver.deadline=time.monotonic()+.07
            program='import time;time.sleep(.25);'+program
        child=self.real_popen([sys.executable,'-c',program],cwd=self.g.root,env=kwargs['env'],
            stdin=kwargs.get('stdin'),stdout=kwargs['stdout'],stderr=kwargs['stderr'],close_fds=True)
        self.children.append(child)
        return child

    def execute(self):
        def host(driver):
            driver.tx.check()
            return {'fixture':'synthetic root policy; ordinary user only'}
        def release_fixture_owners():
            for child in self.children:
                if child.returncode is None:
                    child.wait(timeout=2)
            for tx in list(actor._FAILED_WRITER_OWNERS):
                if tx.path == self.g.control:
                    actor._FAILED_WRITER_OWNERS.remove(tx)
                    os.close(tx.lock);os.close(tx.parent)
        self.addCleanup(release_fixture_owners)
        def factory(tx):
            self.tx=tx
            for stub in (patch.object(type(tx),'_docker_peer',return_value=None),
                         patch.object(type(tx),'_docker_socket_path',self.socket_path)):
                stub.start();self.addCleanup(stub.stop)
            self.driver=actor._InternalForward(tx,self.old_id)
            preparer=self.driver.preparer
            for stub in (patch.object(preparer,'PARENT',self.f.state),
                         patch.object(preparer,'COMPOSE',ROOT/'compose.state-prepare.yaml'),
                         patch.object(preparer.actor.prepared,'read_prepared_proof',side_effect=lambda:actor.prepared._read(self.f.state,self.f.owner,self.f.owner)+b'\n')):
                stub.start();self.addCleanup(stub.stop)
            if self.mutation == 'large-json':
                record=self.driver.call('large-roundtrip',[self.driver.node,'-e',
                    'const fs=require("fs");process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(0,"utf8"))))'],
                    data={'value':'x'*70000})
                self.assertEqual(json.loads(record['rawUtf8']),{'value':'x'*70000})
            return self.driver
        with patch.object(actor.control,'host_control',side_effect=lambda direction, saved_normal:self.g.hold(saved_normal)), \
                patch.object(actor._InternalForward,'_host',host), \
                patch.object(actor._InternalForward,'ROOT',self.g.root), \
                patch.object(actor._InternalForward,'SERVER_UID',os.getuid()):
            return actor.run_actor('to-server',saved.old.IMAGE,factory,saved_normal=self.normal)

    def test_normal_private_parent_exposure_refuses_before_native_mutation(self):
        model=json.loads(self.normal.read_bytes())
        model['services']['bellteam']['volumes'].append(dict(type='bind',source=str(self.g.control.parent),target='/exposed'))
        self.normal.write_text(json.dumps(model))
        with self.assertRaisesRegex(actor.control.ControlError,'NORMAL_EXPOSURE'):self.execute()
        self.assertEqual(self.fake_commands,[])
        self.assertFalse(self.started)

    def test_extra_maintenance_privilege_refuses_before_native_mutation(self):
        path=self.normal.parent/'compose.state-maintenance.json'
        model=json.loads(path.read_bytes())
        model['services']['state-maintenance']['privileged']=True
        path.write_text(json.dumps(model))
        with self.assertRaisesRegex(actor.control.ControlError,'MAINTENANCE_CONFIG'):self.execute()
        self.assertEqual(self.fake_commands,[])
        self.assertFalse(self.started)

    def test_six_phases_consume_native_children_real_node_and_saved_receipts(self):
        result=self.execute()
        self.assertEqual([row['phase'] for row in result],list(actor.control.PHASES))
        journal=json.loads((self.g.control/'transaction-to-server.json').read_bytes())
        self.assertEqual(journal['status'],'completed')
        self.assertEqual(journal['admission']['containerId'],self.selected_id)
        self.assertTrue(self.started)
        self.assertTrue(all(child.returncode==0 for child in self.children))
        for phase in actor.control.PHASES:
            receipt=json.loads((self.g.control/('to-server-'+phase+'.receipt.json')).read_bytes())
            self.assertEqual(receipt['phase'],phase)
        for name in ('initial-writers','started-writers'):
            observation=json.loads((self.g.control/('to-server-'+name+'.verified.json')).read_bytes())
            self.assertFalse(observation['hostWriterAuthorityVerified'])

    def test_named_official_server_user_reaches_all_six_phases(self):
        self.mutation='named-user'
        self.assertEqual(len(self.execute()),6)

    def test_large_native_json_roundtrip_has_bounded_saved_readback(self):
        self.mutation='large-json'
        self.execute()
        path=next(self.g.control.glob('*large-roundtrip.output.json'))
        self.assertGreater(path.stat().st_size,65536)
        fd=os.open(self.g.control,os.O_RDONLY|os.O_DIRECTORY)
        try:
            with self.assertRaisesRegex(actor.control.ControlError,'JOURNAL_CHANGED'):
                actor.control._saved(fd,path.name,self.f.owner)
            value=actor.control._saved(fd,path.name,self.f.owner,limit=4194304)
            self.assertEqual(json.loads(value['rawUtf8']),{'value':'x'*70000})
        finally:os.close(fd)

    def test_unknown_native_child_keeps_same_lock_and_stops_pipeline(self):
        self.mutation='unknown-child'
        with self.assertRaisesRegex(actor.control.ControlError,'CHILD_UNKNOWN'):self.execute()
        self.assertTrue(self.tx._retain_control)
        self.assertIs(actor._FAILED_WRITER_OWNERS[-1],self.tx)
        self.assertEqual(os.fstat(self.tx.lock).st_ino,(self.g.control/'sec014.lock').stat().st_ino)
        program='import fcntl,os,sys;f=os.open(sys.argv[1],os.O_RDWR);fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)'
        child=self.real_popen([sys.executable,'-c',program,str(self.g.control/'sec014.lock')],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        child.communicate();self.assertNotEqual(child.returncode,0)
        journal=json.loads((self.g.control/'transaction-to-server.json').read_bytes())
        self.assertEqual(journal['phases'],['writers_stopped','prepared'])
        self.assertEqual(journal['status'],'incomplete')
        self.assertFalse(self.started)

    def test_foreign_writer_prevents_prepare_and_start(self):
        self.mutation='foreign-writer'
        with self.assertRaises(Exception):self.execute()
        self.assertFalse(self.prepared_live)
        self.assertFalse(self.started)

    def test_maintenance_image_mismatch_prevents_admission(self):
        self.mutation='maintenance-image'
        with self.assertRaisesRegex(actor.control.ControlError,'MAINTENANCE_IDENTITY'):self.execute()
        self.assertFalse(self.created)

    def test_backup_symlink_cannot_become_saved_evidence(self):
        self.mutation='backup-symlink'
        with self.assertRaises(OSError):self.execute()
        self.assertFalse(self.created)

    def test_missing_latest_data_prevents_create_and_start(self):
        self.mutation='current-data'
        with self.assertRaisesRegex(actor.control.ControlError,'CURRENT_DATA_MISMATCH'):self.execute()
        self.assertFalse(self.created)
        self.assertFalse(self.started)

    def test_selected_mount_mismatch_prevents_start(self):
        self.mutation='selected-mount'
        with self.assertRaisesRegex(actor.control.ControlError,'SELECTED_MOUNTS'):self.execute()
        self.assertFalse(self.started)


if __name__ == '__main__':
    names=[name for name in vars(Pipeline) if name.startswith('test_')]
    result=unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite([Forward('test_unprivileged_forward_refuses_before_any_native_command'),*(Pipeline(name) for name in names)]))
    raise SystemExit(not result.wasSuccessful())
