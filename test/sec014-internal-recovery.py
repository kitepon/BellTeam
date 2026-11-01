import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
from datetime import datetime,timezone

sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('recovery_forward_fixture',ROOT/'test/sec014-internal-forward.py')
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
a=f.actor
OLD='sha256:'+'f'*64


class Recovery(f.Pipeline):
    def setUp(self):
        super().setUp()
        self.layout='legacy';self.controlled=False;self.recovery_mutation=None

    def pair(self):
        previous=self.g.root/'.bellteam-compose.OLD123';previous.mkdir(mode=0o700)
        self.previous=previous/'previous-normal.json'
        model=json.loads(json.dumps(self.normal_model));service=model['services']['bellteam'];service['image']=OLD
        if self.layout=='legacy':
            private={v['target'] for v in self.maintenance_model['services']['state-maintenance']['volumes'] if v['target'].startswith('/srv/bellteam/')}
            service['volumes']=[v for v in service['volumes'] if v['target'] not in private]
        if not self.controlled:
            service['environment'].pop('BELLTEAM_NORMAL_ADMISSION_TOKEN')
            service['volumes']=[v for v in service['volumes'] if v['target']!='/run/bellteam-maintenance']
        self.previous_model=model
        self.started_at='2026-10-27T16:03:53Z'
        def write(path,value):path.write_text(json.dumps(value));path.chmod(0o600)
        write(self.previous,model)
        write(previous/'previous-runtime.json',dict(Id=self.old_id,Image=OLD,State={'StartedAt':self.started_at},Config={'User':str(os.getuid())+':'+str(os.getgid())}))
        archive=self.g.root/'runtime/backups/image-before-deploy.ABC123';archive.mkdir(parents=True,mode=0o700)
        for name,value in [('previous-compose.path',str(self.previous)+'\n'),('container-image.txt',self.old_id+' '+OLD+'\n'),('container-started-at.txt',self.started_at+'\n')]:
            path=archive/name;path.write_text(value);path.chmod(0o600)
        write(self.normal.parent/'recovery.json',dict(previousCompose=str(self.previous),previousImageArchive=str(archive),stateLayout=self.layout))
        if self.recovery_mutation=='before-actor':
            self.original_journal=None;return
        with self.g.hold(self.normal):pass
        child=self.real_popen([sys.executable,'-c','import sys;sys.stdin.buffer.read()'],stdin=subprocess.PIPE)
        born=int(Path(f'/proc/{child.pid}/stat').read_text().rsplit(') ',1)[1].split()[19]);child.stdin.close();child.wait(timeout=2)
        journal=self.g.control/'transaction-to-server.json';value=json.loads(journal.read_text());value.update(actorPid=child.pid,actorStartTicks=born)
        journal.write_text(json.dumps(value));journal.chmod(0o640)
        self.original_journal=journal.read_bytes(),journal.stat().st_ino

    def native_reply(self,raw,kwargs,delay=False):
        program='import sys;sys.stdout.buffer.write(bytes.fromhex('+repr(raw.encode().hex())+'))'
        if delay:
            self.driver.deadline=__import__('time').monotonic()+.05
            program='import time;time.sleep(.2);'+program
        child=self.real_popen([sys.executable,'-c',program],cwd=self.g.root,env=kwargs['env'],stdin=kwargs.get('stdin'),stdout=kwargs['stdout'],stderr=kwargs['stderr'],close_fds=True)
        self.children.append(child);return child

    def old_mounts(self):
        return [dict(Type=v['type'],Source=v['source'] if v['type']=='bind' else str(self.volume),Destination=v['target'],RW=not v.get('read_only',False),**({'Name':'fixture_cursor'} if v['type']=='volume' else {})) for v in self.previous_model['services']['bellteam']['volumes']]

    def spawn(self,argv,**kwargs):
        if argv[0]=='/usr/bin/docker' and argv[1]=='inspect' and '--type' in argv and '"imageRef"' not in argv[argv.index('--format')+1]:
            self.fake_commands.append(argv);cid=argv[-1]
            value=dict(id=cid,image=OLD,configImage=OLD,state={'Running':cid==self.selected_id and self.started,'Restarting':False,'StartedAt':self.started_at,'Pid':self.normal_native.pid if cid==self.selected_id and self.started else 0,'Health':{'Status':'healthy'}},user=str(os.getuid())+':'+str(os.getgid()),readonly=True,tmpfs={'/tmp':'rw,nosuid,nodev,size=64m'},service='bellteam',project='bellteam',configFiles=str(self.previous),mounts=self.old_mounts())
            if self.recovery_mutation=='old-image' and cid==self.selected_id:value['image']='sha256:'+'e'*64
            return self.native_reply(json.dumps(value),kwargs)
        if argv[0]=='/usr/bin/docker' and argv[1]=='inspect' and '"imageRef"' in argv[argv.index('--format')+1] and not argv[-1].endswith('-prepare'):
            self.fake_commands.append(argv)
            value=self.inspector();value.update(id=self.maintenance_id,name='/'+argv[-1],project='bellteam',service='state-maintenance',entrypoint=self.maintenance_entrypoint,command=self.maintenance_command,caps=['CHOWN','DAC_OVERRIDE','FOWNER'],mounts=self.mounts_for('state-maintenance'))
            return self.native_reply(json.dumps(value),kwargs)
        if argv[0]=='/usr/bin/docker' and argv[1]=='compose' and ('to-legacy' in argv[-1:] or a._SERVER_RECOVERY_BACKUP in argv[-1:]):
            self.fake_commands.append(argv);self.birth=datetime.now(timezone.utc).isoformat()
            self.maintenance_entrypoint=['/usr/bin/env'] if self.layout=='server' else ['/usr/bin/env','-i','PATH=/usr/local/bin:/usr/bin:/bin','/usr/local/bin/node','/app/src/server-state-transfer.mjs']
            self.maintenance_command=argv[argv.index('state-maintenance')+1:]
            value=dict(direction='to-legacy',status='backup-only' if self.layout=='server' else 'transferred',backups={})
            if self.layout=='legacy':value['ownership']={'direction':'to-legacy'}
            for view in ('legacy','server'):
                parent=self.backups/view/'before-to-legacy';parent.mkdir(parents=True,mode=0o700);(self.backups/view).chmod(0o700)
                if view=='server':
                    name='state/bots/bot-fixture/schedule.json';document=parent/name;document.parent.mkdir(parents=True);document.write_bytes(b'latest-schedule-after-old-capture')
                    target=(self.data/'bots/bot-fixture/schedule.json') if self.layout=='legacy' else self.f.state/'state/bots/bot-fixture/schedule.json'
                    target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(b'corrupt' if self.recovery_mutation=='data' else document.read_bytes())
                marker=json.dumps(dict(schema='bellteam.state-backup.v1',direction='to-legacy',status='complete')).encode();path=parent/'complete.json';path.write_bytes(marker);path.chmod(0o600);info=path.stat()
                value['backups'][view]=dict(status='created',receipt=dict(path='/srv/bellteam-maintenance-backups/'+view+'/before-to-legacy/complete.json',device=str(info.st_dev),inode=str(info.st_ino),sha256=hashlib.sha256(marker).hexdigest()))
            return self.native_reply(json.dumps(value),kwargs,self.recovery_mutation=='unknown-child')
        return super().spawn(argv,**kwargs)

    def execute_recovery(self):
        self.pair()
        def host(driver):driver.tx.check();return {'fixture':'ordinary user, synthetic Host policy and Docker replies'}
        def release_fixture():
            for child in self.children:
                if child.returncode is None:child.wait(timeout=2)
            for tx in list(a._FAILED_WRITER_OWNERS):
                if tx.path==self.g.control:
                    a._FAILED_WRITER_OWNERS.remove(tx);os.close(tx.lock);os.close(tx.parent)
        self.addCleanup(release_fixture)
        with patch.object(a._InternalForward,'_host',host),patch.object(a._InternalForward,'ROOT',self.g.root),patch.object(a._InternalForward,'SERVER_UID',os.getuid()):
            with a._recovery_hold(self.g.control,(os.getuid(),os.getgid()),os.getgid(),self.normal) as tx:
                self.tx=tx
                for stub in (patch.object(type(tx),'_docker_peer',return_value=None),patch.object(type(tx),'_docker_socket_path',self.socket_path)):
                    stub.start();self.addCleanup(stub.stop)
                driver=a._InternalRecovery
                original=driver.__init__
                def construct(instance,*args):
                    original(instance,*args);self.driver=instance
                    for stub in (patch.object(instance.preparer,'PARENT',self.f.state),patch.object(instance.preparer,'COMPOSE',ROOT/'compose.state-prepare.yaml'),patch.object(instance.preparer.actor.prepared,'read_prepared_proof',side_effect=lambda:a.prepared._read(self.f.state,self.f.owner,self.f.owner)+b'\n')):
                        stub.start();self.addCleanup(stub.stop)
                with patch.object(driver,'__init__',construct):result=a._run_recovery(tx,self.old_id)
        journal=self.g.control/'transaction-to-server.json'
        if self.original_journal is None:self.assertFalse(journal.exists())
        else:self.assertEqual((journal.read_bytes(),journal.stat().st_ino),self.original_journal)
        return result

    def test_legacy_latest_backup_inverse_old_normal_and_ex_completion(self):
        result=self.execute_recovery();self.assertEqual([v['phase'] for v in result],list(a.control.PHASES))
        value=json.loads((self.g.control/'recovery-to-legacy.json').read_text())
        self.assertEqual(value['status'],'completed');self.assertIsNone(value['admission']);self.assertFalse(self.tx.shared)
        self.assertFalse((self.g.control/'transaction-to-legacy.json').exists())
        self.assertEqual((self.data/'bots/bot-fixture/schedule.json').read_bytes(),b'latest-schedule-after-old-capture')
        self.assertEqual((self.g.control/'sec014.lock').read_text(),'legacy-recovered\n')

    def test_failure_before_first_actor_recovers_without_a_fake_prior(self):
        self.recovery_mutation='before-actor';self.execute_recovery()
        self.assertTrue(self.started)
        journal=json.loads((self.g.control/'recovery-to-legacy.json').read_text())
        self.assertIsNone(journal['priorJournal'])
        with self.g.hold(self.g.normal('NEXT12')) as tx:self.assertEqual(tx.value['phases'],[])
        self.assertTrue((self.normal.parent/'sec014-control-history/recovery-to-legacy.json').exists())

    def test_server_backup_only_controlled_previous_token_and_shared_handoff(self):
        self.layout='server';self.controlled=True;self.execute_recovery()
        self.assertTrue(self.tx.shared)
        value=json.loads((self.g.control/'transaction-to-legacy.json').read_text());self.assertEqual(value['normal']['image'],OLD)
        self.assertEqual(value['admission']['token'],self.normal_model['services']['bellteam']['environment']['BELLTEAM_NORMAL_ADMISSION_TOKEN'])
        self.assertTrue(any(a._SERVER_RECOVERY_BACKUP in argv for argv in self.fake_commands))
        self.assertFalse(any(argv[-2:]==['state-maintenance','to-legacy'] for argv in self.fake_commands))

    def test_changed_latest_data_refuses_before_old_normal_create(self):
        self.recovery_mutation='data'
        with self.assertRaisesRegex(a.control.ControlError,'DATA_MISMATCH'):self.execute_recovery()
        self.assertFalse(self.created);self.assertFalse(self.started)

    def test_wrong_old_image_refuses_before_exact_start(self):
        self.recovery_mutation='old-image'
        with self.assertRaisesRegex(a.control.ControlError,'SELECTED_CONFIG'):self.execute_recovery()
        self.assertFalse(self.started)

    def test_completed_recovery_moves_original_inodes_before_next_generation(self):
        self.execute_recovery()
        originals={p.name:(p.stat().st_ino,p.read_bytes() if p.is_file() else None) for p in self.g.control.iterdir() if p.name!='sec014.lock'}
        next_normal=self.g.normal('NEXT12')
        with self.g.hold(next_normal) as tx:self.assertEqual(tx.value['phases'],[])
        history=self.normal.parent/'sec014-control-history'
        for name,(inode,raw) in originals.items():
            self.assertEqual((history/name).stat().st_ino,inode)
            if raw is not None:self.assertEqual((history/name).read_bytes(),raw)
        self.assertFalse((self.g.control/'recovery-to-legacy.json').exists())

    def test_changed_completed_receipt_blocks_archive_and_preserves_prior(self):
        self.execute_recovery()
        receipt=self.g.control/'to-legacy-verified.receipt.json';receipt.write_bytes(receipt.read_bytes()+b' ')
        with self.assertRaisesRegex(f.saved.generation.c.ControlError,'RECOVERY_UNRESOLVED'):
            with self.g.hold(self.g.normal('NEXT12')):pass
        self.assertFalse((self.normal.parent/'sec014-control-history').exists())
        journal=self.g.control/'transaction-to-server.json'
        self.assertEqual((journal.read_bytes(),journal.stat().st_ino),self.original_journal)

    def test_unknown_child_retains_ex_and_does_not_start(self):
        self.recovery_mutation='unknown-child'
        with self.assertRaisesRegex(a.control.ControlError,'CHILD_UNKNOWN'):self.execute_recovery()
        self.assertFalse(self.started)
        probe=subprocess.run([sys.executable,'-c','import fcntl,os,sys;fcntl.flock(os.open(sys.argv[1],os.O_RDWR),fcntl.LOCK_EX|fcntl.LOCK_NB)',str(self.g.control/'sec014.lock')],capture_output=True)
        self.assertNotEqual(probe.returncode,0)
        self.assertEqual(json.loads((self.g.control/'recovery-to-legacy.json').read_text())['status'],'incomplete')


if __name__=='__main__':
    result=unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(Recovery(name) for name in Recovery.__dict__ if name.startswith('test_')))
    raise SystemExit(not result.wasSuccessful())
