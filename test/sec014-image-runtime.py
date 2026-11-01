"""Real image admission/UID/FD checks. Only an isolated CI Docker daemon is used."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time


def main():
    if os.geteuid()!=0 or len(sys.argv)!=3:
        raise SystemExit('run as root on the dedicated runner: test IMAGE SOURCE')
    image,source=sys.argv[1:]
    if not re.fullmatch('[a-f0-9]{40}',source) or image!='bellteam-sec014-test:'+source:
        raise SystemExit('SEC014_TEST_IMAGE_SELECTION')
    base=Path(tempfile.mkdtemp(prefix='sec014-image-',dir=os.environ['RUNNER_TEMP']))
    result=Path(os.environ['RUNNER_TEMP'])/'sec014-image-result'
    result.mkdir(mode=0o700)
    containers=[];lock=None;volume=None
    env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/nonexistent','DOCKER_HOST':'unix:///var/run/docker.sock','DOCKER_CONFIG':str(base/'docker-config')}
    (base/'docker-config').mkdir(mode=0o700)
    def docker(*args,check=True):
        return subprocess.run(['/usr/bin/docker',*args],env=env,capture_output=True,text=True,check=check,timeout=45)
    def document(name,value):
        path=result/name;path.write_text(json.dumps(value,indent=2)+'\n');path.chmod(0o600)
    def directory(path,uid=0,gid=0,mode=0o700):
        path.mkdir(parents=True,exist_ok=True);os.chown(path,uid,gid);path.chmod(mode)
    def state_names():
        return {str(p.relative_to(base/'state')) for p in (base/'state').rglob('*')}
    def finish(cid):
        value=json.loads(docker('inspect','--format','{{json .State}}',cid).stdout)
        return value
    def wait_exit(cid):
        until=time.monotonic()+15
        while time.monotonic()<until:
            state=finish(cid)
            if not state['Running']:return state
            time.sleep(.1)
        raise AssertionError('admission rejection did not terminate')
    def assert_ex_busy():
        probe=os.open(base/'control/sec014.lock',os.O_RDWR)
        try:
            try:fcntl.flock(probe,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:return
            raise AssertionError('normal SH missing')
        finally:os.close(probe)
    try:
        image_id=docker('image','inspect','--format','{{.Id}}',image).stdout.strip()
        assert re.fullmatch('sha256:[a-f0-9]{64}',image_id)
        actual_source=docker('run','--rm','--network','none','--read-only','--entrypoint','/usr/local/bin/node',image_id,'-p','JSON.parse(require("fs").readFileSync("/app/distribution.json")).sourceCommit').stdout.strip()
        assert actual_source==source
        directory(base/'control',0,1001,0o750)
        directory(base/'home',1000,1000,0o755)
        directory(base/'data',1000,1000,0o755)
        directory(base/'data/bots',1000,1000,0o755)
        for name in ['shared','shared/tools']:directory(base/'data'/name,1000,1000,0o711)
        targets={'state':'state','rooms':'rooms','owner':'owner','logs':'logs','bellteam-settings':'shared/tools/bellteam-settings','apns':'shared/tools/apns'}
        for name in targets:directory(base/'state'/name,1001,1001,0o711)
        path=base/'control/sec014.lock';path.touch(mode=0o640);os.chown(path,0,1001);path.chmod(0o640)
        lock=os.open(path,os.O_RDWR);held=os.fstat(lock)
        token=os.urandom(32).hex()
        volume='sec014-image-'+base.name.rsplit('-',1)[-1]
        docker('volume','create','--label','bellteam.sec014-test='+source,volume)
        def create():
            args=['create','--init','-i','-t','--read-only','--network','none','--label','bellteam.sec014-test='+source,
                  '--tmpfs','/tmp:exec,size=8g','--tmpfs','/run:size=64m','--tmpfs','/run/bellteam-server:uid=1001,gid=1001,mode=0700,size=64m',
                  '--env','BELLTEAM_NORMAL_ADMISSION_TOKEN='+token]
            for host,target,readonly in [(base/'control','/run/bellteam-maintenance',True),(base/'home','/home/bell',False),(base/'data','/srv/bellteam',False)]:
                args+=['--mount','type=bind,src='+str(host)+',dst='+target+(',readonly' if readonly else '')]
            for name,target in targets.items():args+=['--mount','type=bind,src='+str(base/'state'/name)+',dst=/srv/bellteam/'+target]
            args+=['--mount','type=volume,src='+volume+',dst=/home/bell/.local',image_id]
            cid=docker(*args).stdout.strip();assert re.fullmatch('[a-f0-9]{64}',cid);containers.append(cid);return cid
        def journal(cid,wanted):
            value=dict(schema='bellteam.sec014.host-transaction.v1',direction='to-server',status='incomplete',actorPid=os.getpid(),actorStartTicks=int(Path('/proc/self/stat').read_text().rsplit(') ',1)[1].split()[19]),phases=['writers_stopped','prepared','migrated','binds_confirmed'],admission=dict(containerId=cid,image=image_id,token=wanted))
            p=base/'control/transaction-to-server.json';p.write_text(json.dumps(value));os.chown(p,0,1001);p.chmod(0o640);path.write_text('to-server\n')
        checks=[]
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        cid=create();journal(cid,token);before=state_names();docker('start',cid);state=wait_exit(cid)
        logs=docker('logs',cid).stdout;assert state['ExitCode']==126 and 'BELLTEAM_NORMAL_ADMISSION' in logs and state_names()==before
        checks.append('EX refuses before bootstrap writes')
        fcntl.flock(lock,fcntl.LOCK_SH|fcntl.LOCK_NB)
        cid=create();journal(cid,'f'*64 if token!='f'*64 else 'e'*64);before=state_names();docker('start',cid);state=wait_exit(cid)
        logs=docker('logs',cid).stdout;assert state['ExitCode']==126 and 'BELLTEAM_NORMAL_ADMISSION' in logs and state_names()==before
        checks.append('wrong actual admission token refuses before bootstrap writes')
        cid=create();journal(cid,token);docker('start',cid)
        until=time.monotonic()+35
        health=None
        while time.monotonic()<until:
            state=finish(cid)
            if not state['Running']:
                (result/'failed-normal.log').write_text(docker('logs',cid,check=False).stdout)
                raise AssertionError('normal exited before health: '+str(state['ExitCode']))
            reply=docker('exec','--user','1001:1001',cid,'/usr/local/bin/node','-e',"fetch('http://127.0.0.1:4180/healthz').then(async r=>{if(r.status!==200)throw Error();console.log(JSON.stringify(await r.json()))}).catch(()=>process.exitCode=1)",check=False)
            if reply.returncode==0:
                health=json.loads(reply.stdout);assert health['status']=='ok';break
            time.sleep(.2)
        assert health is not None,'normal health timed out'
        top=docker('top',cid,'-eo','pid,args').stdout.splitlines()[1:]
        matches=[int(row.split(None,1)[0]) for row in top if row.split(None,1)[1]=='/usr/local/bin/node /app/src/supervisor.mjs']
        assert len(matches)==1,top
        pid=matches[0];proc=Path('/proc')/str(pid);born=proc.joinpath('stat').read_text().rsplit(') ',1)[1].split()[19]
        info=proc.joinpath('fdinfo/3').read_text();fd=proc.joinpath('fd/3').stat()
        assert (fd.st_dev,fd.st_ino)==(held.st_dev,held.st_ino)
        assert re.search(r'^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+READ\s+'+str(pid)+r'\s',info,re.M),info
        status=proc.joinpath('status').read_text()
        for field in ['Uid','Gid']:assert re.search(r'^'+field+r':\s+1001\s+1001\s+1001\s+1001$',status,re.M)
        assert proc.joinpath('stat').read_text().rsplit(') ',1)[1].split()[19]==born
        fcntl.flock(lock,fcntl.LOCK_UN);assert_ex_busy()
        child_program="const fs=require('fs');let inherited=false;try{const s=fs.fstatSync(3),v=JSON.parse(process.argv[1]);inherited=s.dev===v.dev&&s.ino===v.ino}catch{};console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),inherited,token:Object.hasOwn(process.env,'BELLTEAM_NORMAL_ADMISSION_TOKEN')}))"
        reply=docker('exec','--user','1001:1001',cid,'sudo','-n','/usr/local/libexec/bellteam-seat-exec','--','/usr/local/bin/node','-e',child_program,json.dumps(dict(dev=held.st_dev,ino=held.st_ino)))
        # Node includes the effective GID after the C entry clears supplementary groups.
        child=json.loads(reply.stdout);assert child==dict(uid=1000,gid=1000,groups=[1000],inherited=False,token=False),child
        # Docker exec does not inherit the supervisor's FD; give the installed entry a proved SH FD directly.
        inherited_entry_program='''import fcntl,json,os,subprocess,sys
p='/run/bellteam-maintenance/sec014.lock'
fd=os.open(p,os.O_RDONLY)
if fd!=3:os.dup2(fd,3);os.close(fd)
os.set_inheritable(3,True);fcntl.flock(3,fcntl.LOCK_SH|fcntl.LOCK_NB)
st=os.fstat(3);wanted=json.loads(sys.argv[2])
assert (st.st_dev,st.st_ino)==(wanted['dev'],wanted['ino'])
info=open('/proc/self/fdinfo/3').read();assert 'FLOCK  ADVISORY  READ' in info,info
os.environ['BELLTEAM_NORMAL_ADMISSION_TOKEN']='test-only-inherited-token'
control=json.loads(subprocess.check_output(['/usr/local/bin/node','-e',sys.argv[1],sys.argv[2]],pass_fds=(3,),text=True))
assert control['inherited'] is True and control['token'] is True,control
print(json.dumps({'precondition':{'device':st.st_dev,'inode':st.st_ino,'inheritable':os.get_inheritable(3),'fdinfo':info,'withoutEntry':control}}),flush=True)
os.execv('/usr/local/libexec/bellteam-seat-exec',['/usr/local/libexec/bellteam-seat-exec','--','/usr/local/bin/node','-e',sys.argv[1],sys.argv[2]])
'''
        proof=docker('exec','--user','0:0',cid,'/usr/bin/python3','-c',inherited_entry_program,child_program,json.dumps(dict(dev=held.st_dev,ino=held.st_ino)))
        rows=[json.loads(row) for row in proof.stdout.splitlines()];assert len(rows)==2,rows
        assert rows[0]['precondition']['inheritable'] and rows[0]['precondition']['withoutEntry']['inherited']
        assert rows[1]==child,rows
        assert_ex_busy();checks+=['actual server UID/GID and same-inode FD3 SH','normal keeps SH after root releases it','actual fixed seat entry changes UID and closes proved inherited SH FD/clears token']
        stopped=time.monotonic();docker('stop',cid);state=wait_exit(cid);elapsed=time.monotonic()-stopped
        assert state['ExitCode']==0,state['ExitCode']
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);fcntl.flock(lock,fcntl.LOCK_UN)
        checks.append('normal exit releases SH; EX reacquired')
        document('result.json',dict(source=source,image=image_id,checks=checks,normalPid=pid,normalStartTicks=int(born),lock=dict(device=held.st_dev,inode=held.st_ino),child=child,seatEntryPrecondition=rows[0]['precondition'],health=health,normalStopSeconds=elapsed,scope='dedicated Linux CI image/UID/kernel lock/seat entry; not production migration, whole-writer authority, public installer or hardware stop-window acceptance'))
    finally:
        errors=[]
        for cid in containers:
            try:
                logs=docker('logs',cid,check=False);(result/(cid[:12]+'.log')).write_text(logs.stdout+'\n'+logs.stderr)
                docker('rm','--force',cid)
            except Exception as error:errors.append(type(error).__name__)
        if volume:
            try:docker('volume','rm',volume)
            except Exception as error:errors.append(type(error).__name__)
        if lock is not None:os.close(lock)
        if not errors:shutil.rmtree(base)
        document('cleanup.json',dict(containerIds=containers,volume=volume,errors=errors))
        if errors:raise RuntimeError('SEC014_TEST_CLEANUP_FAILED')


if __name__=='__main__':main()
