import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from datetime import datetime,timedelta,timezone
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('prepare_executor',ROOT/'distribution/internal/sec014-prepare-executor.py')
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
spec=importlib.util.spec_from_file_location('evidence_fixture',ROOT/'test/sec014-prepare-evidence.py')
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
IMAGE='ghcr.io/kitepon/bellteam-server@sha256:'+'a'*64
IMAGE_ID='sha256:'+'b'*64
CID='c'*64


class PrepareTests(unittest.TestCase):
    def setUp(self):
        self.f=fixture.EvidenceTests();self.f.setUp();self.addCleanup(self.f.doCleanups)
        self.commands=[];self.children=[];self.reaped=[];self.values=None
        self.real_popen=subprocess.Popen
        def cleanup():
            for child in self.children:
                subprocess.Popen.wait(child,timeout=1)
                for stream in (child.stdout,child.stderr):
                    if stream: stream.close()
        self.addCleanup(cleanup)
        self.patches=[patch.object(p,'COMPOSE',ROOT/'compose.state-prepare.yaml'),
                      patch.object(p,'PARENT',self.f.state),
                      patch.object(p.actor.prepared,'read_prepared_proof',side_effect=self.f.raw),
                      patch.object(p.subprocess,'Popen',side_effect=self.spawn)]
        for x in self.patches:x.start();self.addCleanup(x.stop)
        self.mutate=lambda value:value
        self.output=None;self.birth=None

    def inspector(self):
        name=p.actor.prepare_name(self.tx)
        value=dict(id=CID,name='/'+name,imageRef=IMAGE,imageId=IMAGE_ID,
            service='state-prepare',project='bellteam-state-prepare',status='exited',running=False,
            pid=0,exitCode=0,oom=False,user='0:0',ro=True,network='none',
            createdAt=self.birth,startedAt=self.birth,finishedAt=self.birth,restarts=0,init=True,
            entrypoint=['/usr/bin/env','-i','PATH=/usr/local/bin:/usr/bin:/bin','/usr/local/bin/node','/app/src/server-state-prepare.mjs'],command=None,
            memory=2147483648,swap=2147483648,cpu=1000000000,pids=512,
            caps=['CHOWN'],drop=['ALL'],security=['no-new-privileges:true'],
            tmpfs={'/tmp':'rw,nosuid,nodev,size=64m'},
            mounts=[dict(Type='bind',Source=str(self.f.state),Destination='/srv/bellteam-state-parent',RW=True)])
        return self.mutate(value)

    def spawn(self,argv,**kwargs):
        self.commands.append((argv,kwargs['env']))
        index=len(self.commands)
        if index==1:self.birth=datetime.now(timezone.utc).isoformat()
        raw=[b'{"status":"prepared"}\n',json.dumps(self.inspector()).encode(),CID.encode()+b'\n',b''][index-1]
        err=self.output if self.output and index==1 else b''
        # Fake Docker protocol, actual dedicated Python client only.
        program='import sys;sys.stdout.buffer.write(bytes.fromhex('+repr(raw.hex())+'));sys.stderr.buffer.write(bytes.fromhex('+repr(err.hex())+'))'
        child=self.real_popen([sys.executable,'-c',program],cwd=self.f.root,env=kwargs['env'],
                              stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,close_fds=True)
        self.children.append(child);wait=child.wait
        slot=['run','inspect','remove','absence'][index-1]
        def reap(timeout):
            terminal=self.f.root/f'to-server-prepare-{slot}.terminal.json'
            self.assertTrue(terminal.exists())
            self.assertEqual(json.loads(terminal.read_bytes())['pid'],child.pid)
            self.assertIsNotNone(os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOWAIT|os.WNOHANG))
            self.reaped.append(child.pid)
            return wait(timeout=timeout)
        child.wait=reap
        return child

    def runner(self,host=None,deadline=None):
        return p._Prepare(self.tx,IMAGE,IMAGE_ID,deadline or time.monotonic()+110,
                          datetime.now(timezone.utc)+timedelta(seconds=120),host or (lambda:'d'*64))

    def journal(self):
        return json.loads((self.f.root/'transaction-to-server.json').read_bytes())

    def test_four_fixed_commands_env_terminal_before_reap_and_phase_evidence(self):
        with self.f.hold() as self.tx, patch.dict(os.environ,{'BELLTEAM_WEB_TOKEN':'synthetic-secret','DOCKER_HOST':'invalid'}):
            receipt=self.runner().prepare()
            self.assertEqual(len(self.commands),4)
            self.assertEqual(self.commands[0][0],['/usr/bin/docker','compose','--env-file','/dev/null','-f',
                '/home/kite/BellTeam/compose.state-prepare.yaml','run','--no-deps','--name',p.actor.prepare_name(self.tx),'-T','state-prepare'])
            self.assertEqual(self.commands[2][0],['/usr/bin/docker','rm',CID])
            self.assertNotIn('.Config.Env',self.commands[1][0][5])
            for argv,env in self.commands:
                self.assertEqual(set(env),{'PATH','HOME','LANG','DOCKER_CONFIG','BELLTEAM_SERVER_IMAGE','BELLTEAM_STATE_PARENT'})
                self.assertEqual(list(Path(env['DOCKER_CONFIG']).iterdir()),[])
            self.assertEqual(len(self.reaped),4)
            self.assertEqual(self.journal()['phases'],[])
            p.actor._receipt(self.tx,'prepared',IMAGE,receipt,p.actor.PROOFS[0]);self.tx.confirmed('prepared')
        self.assertEqual(self.journal()['phases'],['prepared'])
        self.assertEqual(self.journal()['status'],'incomplete')

    def test_running_container_never_reaches_remove_or_phase(self):
        self.mutate=lambda value:dict(value,status='running',running=True,pid=123)
        with self.f.hold() as self.tx:
            runner=self.runner()
            with self.assertRaisesRegex(p.actor.control.ControlError,'PHASE_UNCONFIRMED'):runner.prepare()
            self.assertTrue(runner.held)
        self.assertEqual(len(self.commands),2)
        self.assertFalse((self.f.root/'to-server-prepare-evidence.json').exists())
        self.assertEqual(self.journal()['phases'],[])

    def test_extra_mount_never_reaches_remove_or_phase(self):
        self.mutate=lambda v:dict(v,mounts=v['mounts']+[dict(Type='bind',Source='/x',Destination='/home/bell',RW=True)])
        with self.f.hold() as self.tx:
            with self.assertRaisesRegex(p.actor.control.ControlError,'PHASE_UNCONFIRMED'):self.runner().prepare()
        self.assertEqual(len(self.commands),2)
        self.assertEqual(self.journal()['phases'],[])

    def test_old_container_birth_cannot_be_adopted_after_cli_exit0(self):
        old=(datetime.now(timezone.utc)-timedelta(hours=1)).isoformat()
        self.mutate=lambda v:dict(v,createdAt=old,startedAt=old,finishedAt=old)
        with self.f.hold() as self.tx:
            with self.assertRaises(p.actor.control.ControlError):self.runner().prepare()
        self.assertEqual(len(self.commands),2)
        self.assertEqual(self.journal()['phases'],[])

    def test_output_limit_holds_without_inspect_or_error_body_saved(self):
        self.output=b'sensitive-marker'*400
        with self.f.hold() as self.tx:
            runner=self.runner()
            with self.assertRaisesRegex(p.actor.control.ControlError,'PHASE_UNCONFIRMED'):runner.prepare()
            self.assertTrue(runner.held)
        self.assertEqual(len(self.commands),1)
        self.assertEqual(self.reaped,[])
        records=b''.join(x.read_bytes() for x in self.f.root.glob('*.json'))
        self.assertNotIn(b'sensitive-marker',records)
        self.assertEqual(self.journal()['phases'],[])

    def test_claim_io_expiry_refuses_before_first_child_and_no_retry(self):
        mono=[1000.0];save=p.actor._save_json
        def expire(tx,name,value):
            result=save(tx,name,value)
            if name.endswith('run.claim.json'):mono[0]=1111
            return result
        with self.f.hold() as self.tx,patch.object(p.time,'monotonic',side_effect=lambda:mono[0]):
            runner=self.runner(deadline=1110)
            with patch.object(p.actor,'_save_json',side_effect=expire):
                with self.assertRaises(p.actor.control.ControlError):runner.prepare()
            with self.assertRaises(p.actor.control.ControlError):runner.call('run')
        self.assertEqual(self.commands,[])
        self.assertEqual(self.journal()['phases'],[])

    def test_terminal_persistence_failure_never_reaps_or_inspects(self):
        save=p.actor._save_json
        def fail(tx,name,value):
            if name.endswith('run.terminal.json'):raise OSError('synthetic terminal persistence')
            return save(tx,name,value)
        with self.f.hold() as self.tx,patch.object(p.actor,'_save_json',side_effect=fail):
            with self.assertRaises(p.actor.control.ControlError):self.runner().prepare()
        self.assertEqual(len(self.commands),1)
        self.assertEqual(self.reaped,[])
        self.assertIsNotNone(os.waitid(os.P_PID,self.children[0].pid,os.WEXITED|os.WNOWAIT|os.WNOHANG))
        self.assertEqual(self.journal()['phases'],[])

    def test_missing_host_original_refuses_before_docker(self):
        def missing():raise RuntimeError('authority unavailable')
        with self.f.hold() as self.tx:
            with self.assertRaises(p.actor.control.ControlError):self.runner(host=missing).prepare()
        self.assertEqual(self.commands,[])
        self.assertEqual(self.journal()['phases'],[])


if __name__=='__main__':unittest.main(verbosity=2)
