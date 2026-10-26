"""Fixed prepare producer. No CLI; host authority verifier and later phases absent."""
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import selectors
import subprocess
import time
from datetime import datetime, timezone

spec = importlib.util.spec_from_file_location('sec014_prepare_actor',
    Path(__file__).with_name('sec014-host-actor.py'))
actor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(actor)
COMPOSE = Path('/home/kite/BellTeam/compose.state-prepare.yaml')
COMPOSE_SHA = 'e9bd60d9f204fd57dde69e1ddde710f4031335725a6242a1de00db1ce05db680'
PARENT = actor.control.CONTROL.parent/'state-data'
FIELDS = {'id':'.Id', 'name':'.Name', 'imageRef':'.Config.Image', 'imageId':'.Image',
          'service':'(index .Config.Labels "com.docker.compose.service")',
          'project':'(index .Config.Labels "com.docker.compose.project")',
          'status':'.State.Status', 'running':'.State.Running', 'pid':'.State.Pid',
          'exitCode':'.State.ExitCode', 'oom':'.State.OOMKilled', 'mounts':'.Mounts',
          'createdAt':'.Created', 'startedAt':'.State.StartedAt', 'finishedAt':'.State.FinishedAt',
          'restarts':'.RestartCount', 'entrypoint':'.Config.Entrypoint', 'command':'.Config.Cmd', 'init':'.HostConfig.Init',
          'user':'.Config.User', 'ro':'.HostConfig.ReadonlyRootfs',
          'network':'.HostConfig.NetworkMode', 'memory':'.HostConfig.Memory',
          'swap':'.HostConfig.MemorySwap', 'cpu':'.HostConfig.NanoCpus',
          'pids':'.HostConfig.PidsLimit', 'caps':'.HostConfig.CapAdd',
          'drop':'.HostConfig.CapDrop', 'security':'.HostConfig.SecurityOpt',
          'tmpfs':'.HostConfig.Tmpfs'}
TEMPLATE = '{'+','.join('"'+k+'":{{json '+v+'}}' for k,v in FIELDS.items())+'}'


class _Prepare:
    """Private current-owner tests inject paths/Popen; production has fixed paths."""
    def __init__(self, tx, image, image_id, deadline, window_end, host_check):
        if (not isinstance(image,str) or not re.fullmatch(r'ghcr\.io/kitepon/bellteam-server@sha256:[a-f0-9]{64}',image)
                or not isinstance(image_id,str) or not re.fullmatch('sha256:[a-f0-9]{64}',image_id)
                or type(deadline) not in (int,float) or not math.isfinite(deadline)
                or not 2 < deadline-time.monotonic() <= 120 or not callable(host_check)
                or not isinstance(window_end,datetime) or window_end.utcoffset() is None):
            raise actor.control.ControlError('SEC014_PREPARE_SCOPE')
        if not callable(getattr(host_check,'bind_image',None)):
            raise actor.control.ControlError('SEC014_PREPARE_HOST_IMAGE_BINDING')
        host_check.bind_image(image,image_id)
        self.tx,self.image,self.image_id = tx,image,image_id
        self.deadline,self.end,self.host_check = deadline,window_end,host_check
        self.held,self.children,self.records = False,[],[]
        self.proof,self.cid,self.env = None,None,None
        self.step = 'entry'

    def ready(self):
        self.tx.check()
        if self.held or time.monotonic() >= self.deadline-1 or datetime.now(timezone.utc) >= self.end:
            raise actor.control.ControlError('SEC014_PREPARE_DEADLINE_OR_HELD')
        proof = self.host_check(self.step)
        if (type(proof) is not str or not re.fullmatch('[a-f0-9]{64}',proof)
                or self.proof is not None and proof != self.proof):
            raise actor.control.ControlError('SEC014_PREPARE_HOST_ORIGINAL')
        self.proof = proof
        if time.monotonic() >= self.deadline-1 or datetime.now(timezone.utc) >= self.end:
            raise actor.control.ControlError('SEC014_PREPARE_DEADLINE_OR_HELD')

    def save(self, slot, value):
        return actor._save_json(self.tx,self.tx.value['direction']+'-prepare-'+slot+'.json',value)

    def call(self, slot):
        child, born = None,None
        try:
            if slot not in ('run','inspect','remove','absence'):
                raise actor.control.ControlError('SEC014_PREPARE_FIXED_SLOT')
            self.step = slot
            self.ready()
            commands={
                'run':(actor.prepare_argv(self.tx),60),
                'inspect':(['/usr/bin/docker','inspect','--type','container','--format',TEMPLATE,actor.prepare_name(self.tx)],10),
                'remove':(['/usr/bin/docker','rm',self.cid],10),
                'absence':(['/usr/bin/docker','container','ls','--all','--quiet','--no-trunc','--filter','id='+str(self.cid)],10)}
            if slot not in commands or self.env is None or slot in ('remove','absence') and self.cid is None:
                raise actor.control.ControlError('SEC014_PREPARE_FIXED_SLOT')
            argv,seconds=commands[slot]
            env=self.env
            end = min(self.deadline-1,time.monotonic()+seconds)
            self.save(slot+'.claim',{'argv':argv,'image':self.image,'hostParentProof':self.proof})
            self.ready()
            if time.monotonic() >= end:
                raise actor.control.ControlError('SEC014_PREPARE_CLIENT_DEADLINE')
            issued_at=datetime.now(timezone.utc).isoformat()
            child = subprocess.Popen(argv,cwd='/home/kite/BellTeam',env=env,stdin=subprocess.DEVNULL,
                                     stdout=subprocess.PIPE,stderr=subprocess.PIPE,close_fds=True)
            self.children.append(child)
            born = int(Path(f'/proc/{child.pid}/stat').read_text().rsplit(') ',1)[1].split()[19])
            self.save(slot+'.spawn',{'pid':child.pid,'startTicks':born})
            output,error = bytearray(),bytearray()
            terminal = None
            with selectors.DefaultSelector() as selector:
                for stream,buffer,limit in ((child.stdout,output,32768),(child.stderr,error,4096)):
                    os.set_blocking(stream.fileno(),False)
                    selector.register(stream,selectors.EVENT_READ,(buffer,limit))
                while terminal is None or selector.get_map():
                    left=end-time.monotonic()
                    if left<=0 or datetime.now(timezone.utc)>=self.end:
                        raise actor.control.ControlError('SEC014_PREPARE_CLIENT_DEADLINE')
                    for key,_ in selector.select(min(left,.02)):
                        chunk=os.read(key.fd,32768)
                        buffer,limit=key.data
                        if not chunk:
                            selector.unregister(key.fileobj);key.fileobj.close()
                        elif len(buffer)+len(chunk)>limit:
                            raise actor.control.ControlError('SEC014_PREPARE_OUTPUT_LIMIT')
                        else: buffer.extend(chunk)
                    seen=os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOWAIT|os.WNOHANG)
                    if seen: terminal={'kind':'exit' if seen.si_code==os.CLD_EXITED else 'signal','code':seen.si_status}
            record={'pid':child.pid,'startTicks':born,'terminal':terminal,
                    'issuedAt':issued_at,'endedAt':datetime.now(timezone.utc).isoformat(),
                    'stdoutBytes':len(output),'stdoutSha256':hashlib.sha256(output).hexdigest(),
                    'stderrBytes':len(error),'stderrSha256':hashlib.sha256(error).hexdigest()}
            digest=self.save(slot+'.terminal',record)
            if time.monotonic()>=self.deadline or datetime.now(timezone.utc)>=self.end:
                raise actor.control.ControlError('SEC014_PREPARE_REAP_BUDGET')
            code=child.wait(timeout=min(1,self.deadline-time.monotonic()))
            if terminal!={'kind':'exit','code':0} or code!=0:
                raise actor.control.ControlError('SEC014_PREPARE_CLIENT_NONZERO_OR_SIGNAL')
            self.records.append({'slot':slot,'terminalSha256':digest})
            return bytes(output),record
        except Exception as failure:
            self.held=True
            try:self.host_check.invalidate('UNCONFIRMED_CHILD')
            except Exception:pass
            try: self.save(slot+'.unknown',{'reason':'SEC014_PREPARE_HELD_OR_UNKNOWN',
                'errorType':type(failure).__name__,'pid':None if child is None else child.pid,
                'startTicks':born,'daemonCompletion':'unknown'})
            except Exception: pass
            raise actor.control.ControlError('SEC014_PREPARE_HELD_OR_UNKNOWN') from None

    def prepare(self):
        try:
            return self._prepare()
        except Exception as failure:
            self.held=True
            try:self.host_check.invalidate('UNCONFIRMED_CHILD')
            except Exception:pass
            try: self.save('phase.unknown',{'reason':'SEC014_PREPARE_PHASE_UNCONFIRMED',
                'errorType':type(failure).__name__,'containerName':actor.prepare_name(self.tx),'knownCid':self.cid})
            except Exception: pass
            raise actor.control.ControlError('SEC014_PREPARE_PHASE_UNCONFIRMED') from None

    def _prepare(self):
        self.tx.check()
        if COMPOSE.is_symlink() or hashlib.sha256(COMPOSE.read_bytes()).hexdigest()!=COMPOSE_SHA:
            raise actor.control.ControlError('SEC014_PREPARE_COMPOSE_PIN')
        config=self.tx.path/(self.tx.value['direction']+'-prepare-empty-docker-config')
        config.mkdir(mode=0o700)
        actor.control._private(config.lstat(),self.tx.owner,True)
        self.env={'PATH':'/usr/bin:/bin','HOME':'/nonexistent','LANG':'C.UTF-8',
             'DOCKER_CONFIG':str(config),'BELLTEAM_SERVER_IMAGE':self.image,
             'BELLTEAM_STATE_PARENT':str(PARENT)}
        self.ready()
        argv=actor.prepare_argv(self.tx)
        _,run=self.call('run')
        name=actor.prepare_name(self.tx)
        raw,_=self.call('inspect')
        value=json.loads(raw)
        wanted=dict(name='/'+name,imageRef=self.image,imageId=self.image_id,
            service='state-prepare',project='bellteam-state-prepare',status='exited',running=False,
            pid=0,exitCode=0,oom=False,user='0:0',ro=True,network='none',restarts=0,init=True,
            entrypoint=['/usr/bin/env','-i','PATH=/usr/local/bin:/usr/bin:/bin','/usr/local/bin/node','/app/src/server-state-prepare.mjs'],
            memory=2147483648,swap=2147483648,cpu=1000000000,pids=512,
            drop=['ALL'],security=['no-new-privileges:true'],tmpfs={'/tmp':'rw,nosuid,nodev,size=64m'})
        if (type(value) is not dict or set(value)!=set(FIELDS)
                or any(value[k]!=v or type(value[k]) is not type(v) for k,v in wanted.items())
                or type(value['id']) is not str or not re.fullmatch('[a-f0-9]{64}',value['id'])
                or value['caps'] not in (['CHOWN'],['CAP_CHOWN'])
                or type(value['mounts']) is not list or value['command'] not in (None,[])):
            raise actor.control.ControlError('SEC014_PREPARE_CONTAINER_UNCONFIRMED')
        dates=[datetime.fromisoformat(value[k].replace('Z','+00:00')) for k in ('createdAt','startedAt','finishedAt')]
        if (any(t.utcoffset() is None for t in dates)
                or not datetime.fromisoformat(run['issuedAt']) <= dates[0] <= dates[1] <= dates[2] <= datetime.fromisoformat(run['endedAt'])):
            raise actor.control.ControlError('SEC014_PREPARE_CONTAINER_BIRTH')
        binds=[m for m in value['mounts'] if m.get('Type')=='bind']
        extras=[m for m in value['mounts'] if m.get('Type')!='bind']
        if (len(binds)!=1 or binds[0].get('Source')!=str(PARENT)
                or binds[0].get('Destination')!='/srv/bellteam-state-parent'
                or binds[0].get('RW') is not True
                or any(m.get('Type')!='tmpfs' or m.get('Destination')!='/tmp' for m in extras)
                or len(extras)>1):
            raise actor.control.ControlError('SEC014_PREPARE_MOUNT_UNCONFIRMED')
        cid=value['id']
        self.cid=cid
        self.save('container',{'rawUtf8':raw.decode(),'sha256':hashlib.sha256(raw).hexdigest()})
        removed,_=self.call('remove')
        if removed.strip().decode('ascii')!=cid:
            raise actor.control.ControlError('SEC014_PREPARE_REMOVAL_UNCONFIRMED')
        absent,_=self.call('absence')
        if absent.strip(): raise actor.control.ControlError('SEC014_PREPARE_REMOVAL_UNCONFIRMED')
        self.step = 'metadata'
        self.ready()
        terminal=dict(schema='bellteam.sec014.prepare-terminal.v1',direction=self.tx.value['direction'],
            image=self.image,actorPid=self.tx.value['actorPid'],actorStartTicks=self.tx.value['actorStartTicks'],
            clientPid=run['pid'],clientStartTicks=run['startTicks'],containerId=cid,containerName=name,
            argv=argv,status='exited',exitCode=0,unknown=False)
        self.save('chain',{'terminal':terminal,'commands':self.records,'hostParentProof':self.proof})
        receipt=actor.prepared_phase_receipt(self.tx,self.image,terminal,self.proof)
        self.step = 'phase'
        self.ready()
        return receipt

