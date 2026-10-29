"""Private held-generation metadata collector; never a host-authority receipt or CLI."""
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import selectors
import shutil
import subprocess
import time
from datetime import datetime, timezone

spec = importlib.util.spec_from_file_location('writer_actor', Path(__file__).with_name('sec014-host-actor.py'))
actor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(actor)
NODE_EXECUTABLE = shutil.which('node', path='/usr/local/bin:/usr/bin:/bin')
LIST = ['/usr/bin/docker', 'container', 'ls', '--all', '--quiet', '--no-trunc']
NODE = '''
import {writerSnapshotPlan,verifyWriterSnapshot,writerContainerInspectArgv,writerVolumeInspectArgv} from MODULE;
import {stateWriterVolumes,stateWriterSources} from STATE;
const chunks=[];for await(const c of process.stdin)chunks.push(c);
const x=JSON.parse(Buffer.concat(chunks)); let result;
if(x.stage==='plan') result=writerSnapshotPlan(x.config,x.image,x.imageId);
else if(x.stage==='inspect') result=writerContainerInspectArgv(x.ids);
else if(x.stage==='volumes') result=stateWriterVolumes(x.plan.mounts,x.containers).map(writerVolumeInspectArgv);
else if(x.stage==='sources') {
 const paths=stateWriterSources(x.plan.mounts,x.containers,x.volumes);
 if(paths.length>512)throw new Error('limit');
 const participating=x.containers.filter(c=>c.running||c.restarting||!['','no'].includes(c.restartPolicy));
 const observed=new Set([...participating.flatMap(c=>c.mounts.filter(m=>m.RW&&['bind','volume'].includes(m.Type)).map(m=>m.Source)),
   ...x.volumes.flatMap(v=>[v.mountpoint,...(v.device===null?[]:[v.device])])]);
 result=paths.map(source=>({source,observed:observed.has(source)}));
} else if(x.stage==='verify') result=verifyWriterSnapshot(x.plan,x.bundle);
else throw new Error('stage');
console.log(JSON.stringify(result));
'''.replace('MODULE', json.dumps(Path(__file__).with_name('sec014-writer-snapshot.mjs').as_uri())).replace(
    'STATE', json.dumps((Path(__file__).resolve().parents[2]/'src/server-state-writers.mjs').as_uri()))


class _Writer:
    def __init__(self, tx, image, image_id, deadline, window_end):
        if (type(deadline) not in (int,float) or not math.isfinite(deadline)
                or not 2 < deadline-time.monotonic() <= 120
                or not isinstance(window_end,datetime) or window_end.utcoffset() is None):
            raise actor.control.ControlError('SEC014_WRITER_SCOPE')
        self.tx,self.image,self.image_id,self.deadline,self.end=tx,image,image_id,deadline,window_end
        self.children=[]
        self.held=False
        self.env=None

    def ready(self):
        self.tx.check()
        if self.held or time.monotonic()>=self.deadline-1 or datetime.now(timezone.utc)>=self.end:
            raise actor.control.ControlError('SEC014_WRITER_DEADLINE_OR_HELD')
        for child,born in self.children:
            if int(Path(f'/proc/{child.pid}/stat').read_text().rsplit(') ',1)[1].split()[19])!=born:
                raise actor.control.ControlError('SEC014_WRITER_CLIENT_IDENTITY')

    def save(self, slot, value):
        return actor._save_json(self.tx,self.tx.value['direction']+'-writer-'+slot+'.json',value)

    def query(self, stage, **fields):
        self.ready()
        raw=json.dumps(dict(stage=stage,**fields),allow_nan=False).encode()
        # Fixed programs and bounded metadata inputs; no caller-supplied code or Compose credentials.
        if len(raw)>4194304: raise actor.control.ControlError('SEC014_WRITER_QUERY_LIMIT')
        self.ready()
        if NODE_EXECUTABLE is None: raise actor.control.ControlError('SEC014_WRITER_NODE_UNAVAILABLE')
        result=subprocess.run([NODE_EXECUTABLE,'--input-type=module','-e',NODE],input=raw,
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'},
            timeout=min(5,self.deadline-time.monotonic()-1),check=True)
        if len(result.stdout)>4194304: raise actor.control.ControlError('SEC014_WRITER_QUERY_LIMIT')
        self.ready()
        return json.loads(result.stdout)

    def client(self, slot, argv, limit):
        self.ready()
        self.save(slot+'.claim',dict(argv=argv,image=self.image,imageId=self.image_id))
        self.ready()
        end=min(self.deadline-1,time.monotonic()+10)
        child=subprocess.Popen(argv,cwd='/home/kite/BellTeam',env=self.env,stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,close_fds=True)
        self.children.append((child,None))
        born=int(Path(f'/proc/{child.pid}/stat').read_text().rsplit(') ',1)[1].split()[19])
        self.children[-1]=(child,born)
        self.save(slot+'.spawn',dict(pid=child.pid,startTicks=born))
        output,error=bytearray(),bytearray()
        terminal=None
        with selectors.DefaultSelector() as selector:
            for stream,buffer,cap in ((child.stdout,output,limit),(child.stderr,error,4096)):
                os.set_blocking(stream.fileno(),False)
                selector.register(stream,selectors.EVENT_READ,(buffer,cap))
            while terminal is None or selector.get_map():
                self.ready()
                left=end-time.monotonic()
                if left<=0: raise actor.control.ControlError('SEC014_WRITER_CLIENT_DEADLINE')
                for key,_ in selector.select(min(left,.02)):
                    chunk=os.read(key.fd,32768);buffer,cap=key.data
                    if not chunk:
                        selector.unregister(key.fileobj);key.fileobj.close()
                    elif len(buffer)+len(chunk)>cap:
                        raise actor.control.ControlError('SEC014_WRITER_OUTPUT_LIMIT')
                    else: buffer.extend(chunk)
                seen=os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOWAIT|os.WNOHANG)
                if seen: terminal={'kind':'exit' if seen.si_code==os.CLD_EXITED else 'signal','code':seen.si_status}
        record=dict(argv=argv,clientPid=child.pid,clientStartTicks=born,unknown=False,terminal=terminal,
            stdoutBytes=len(output),stdoutSha256=hashlib.sha256(output).hexdigest(),
            stderrBytes=len(error),stderrSha256=hashlib.sha256(error).hexdigest())
        self.save(slot+'.terminal',record)
        record['rawUtf8']=output.decode('utf-8',errors='strict')
        self.save(slot+'.output',record)
        if terminal!={'kind':'exit','code':0}:
            raise actor.control.ControlError('SEC014_WRITER_CLIENT_NONZERO_OR_SIGNAL')
        return record

    def snapshot(self):
        try:
            config=self.tx._writer_config()
            plan=self.query('plan',config=config,image=self.image,imageId=self.image_id)
            path=self.tx.path/(self.tx.value['direction']+'-writer-empty-docker-config')
            path.mkdir(mode=0o700)
            actor.control._private(path.lstat(),self.tx.owner,True)
            self.env={'PATH':'/usr/bin:/bin','HOME':'/nonexistent','LANG':'C.UTF-8','DOCKER_CONFIG':str(path)}
            listed=self.client('list',LIST,8320)
            ids=listed['rawUtf8'].splitlines()
            if (len(ids)>128 or len(set(ids))!=len(ids)
                    or any(not re.fullmatch('[a-f0-9]{64}',value) for value in ids)):
                raise actor.control.ControlError('SEC014_WRITER_CONTAINER_IDS')
            inspected=self.client('containers',self.query('inspect',ids=ids),1048576) if ids else None
            containers=[json.loads(row) for row in inspected['rawUtf8'].splitlines() if row] if inspected else []
            commands=self.query('volumes',plan=plan,containers=containers)
            if len(commands)>128: raise actor.control.ControlError('SEC014_WRITER_VOLUME_LIMIT')
            volumes=[self.client('volume-'+str(i),argv,16384) for i,argv in enumerate(commands)]
            backing=[json.loads(record['rawUtf8']) for record in volumes]
            sources=self.query('sources',plan=plan,containers=containers,volumes=backing)
            canonical=[]
            for item in sources:
                source=item['source']
                if len(source)>4096: raise actor.control.ControlError('SEC014_WRITER_PATH_LIMIT')
                current=Path(source);suffix=[]
                if item['observed'] and not current.exists():
                    raise actor.control.ControlError('SEC014_WRITER_OBSERVED_PATH_MISSING')
                while not current.exists():
                    if current.is_symlink() or current.parent==current:
                        raise actor.control.ControlError('SEC014_WRITER_PATH_INVALID')
                    suffix.insert(0,current.name);current=current.parent
                canonical.append(dict(source=source,canonical=str(current.resolve(strict=True).joinpath(*suffix))))
            bundle=dict(list=listed,containers=inspected,volumes=volumes,canonical=canonical)
            observation=self.query('verify',plan=plan,bundle=bundle)
            self.save('observation',observation)
            self.ready()
            # Keep every exact native child unreaped through verification and durable observation.
            for child,born in self.children:
                if int(Path(f'/proc/{child.pid}/stat').read_text().rsplit(') ',1)[1].split()[19])!=born:
                    raise actor.control.ControlError('SEC014_WRITER_CLIENT_IDENTITY')
                if child.wait(timeout=min(1,self.deadline-time.monotonic()))!=0:
                    raise actor.control.ControlError('SEC014_WRITER_REAP_UNCONFIRMED')
            self.tx.check()
            return observation
        except Exception as failure:
            self.held=True
            try:self.save('unknown',dict(reason='SEC014_WRITER_HELD_OR_UNKNOWN',errorType=type(failure).__name__,
                clients=[dict(pid=child.pid,startTicks=born) for child,born in self.children],daemonCompletion='unknown'))
            except Exception:pass
            raise actor.control.ControlError('SEC014_WRITER_HELD_OR_UNKNOWN') from None
