#!/usr/bin/python3
"""Disposable root/systemd mechanism acceptance. Engine and signature receipts remain artificial."""
import configparser
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import uuid

ROOT=Path(__file__).resolve().parents[2]
ENV={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/root','LANG':'C.UTF-8'}

def run(args,**options):
    return subprocess.run(args,env=ENV,cwd='/',stdin=subprocess.DEVNULL,capture_output=True,text=True,timeout=30,check=True,**options).stdout.strip()
def wait(predicate):
    until=time.monotonic()+30
    while time.monotonic()<until:
        if predicate():return
        time.sleep(.05)
    raise RuntimeError('NATIVE_FIXTURE_TIMEOUT')

def main():
    if os.getuid()!=0 or os.environ.get('BELLTEAM_UPDATER_NATIVE_FIXTURE')!='disposable':
        raise RuntimeError('DISPOSABLE_ROOT_SYSTEMD_REQUIRED')
    systemctl=shutil.which('systemctl');manager=shutil.which('systemd-run')
    if not systemctl or not manager or not Path('/run/systemd/system').is_dir():raise RuntimeError('SYSTEM_MANAGER_REQUIRED')
    python=str(Path(sys.executable).resolve())
    units=[]
    with tempfile.TemporaryDirectory(prefix='bellteam-updater-native-',dir='/run') as temporary:
        prefix=Path(temporary);prefix.chmod(0o755)
        for name,mode in [('state',0o700),('catalog',0o755),('installation',0o700),('socket',0o750)]:
            (prefix/name).mkdir(mode=mode)
        os.chown(prefix/'socket',0,1001)
        release=prefix/'releases'/('a'*40);(release/'scripts').mkdir(parents=True)
        runtime=release/'scripts/runtime-core.py';shutil.copyfile(ROOT/'scripts/container-update-host.py',runtime)
        spec=importlib.util.spec_from_file_location('runtime',runtime);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        current={'containerId':'a'*64,'imageId':'sha256:'+'b'*64,'sourceCommit':'c'*40,'health':'healthy','imageRef':None}
        config={'release':'a'*40,'projectName':'fixture','platform':{'os':'linux','arch':'amd64'},'python':python,
                'systemdRun':manager,'installRoot':str(prefix/'installation'),'writePaths':[]}
        (prefix/'fixture.json').write_text(json.dumps({'config':config,'current':current}))
        wrapper=release/'scripts/container-update-host.py'
        wrapper.write_text("import importlib.util,json,sys,time,os\nfrom pathlib import Path\n"+
          "p=Path("+repr(str(prefix))+");s=importlib.util.spec_from_file_location('core',"+repr(str(runtime))+");m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n"+
          "v=json.loads((p/'fixture.json').read_text())\n"+
          "def execute(plan,directory):\n until=time.monotonic()+60\n while not (p/'state/release-worker').exists():\n  if time.monotonic()>until:raise RuntimeError()\n  time.sleep(.02)\n return dict(execution='succeeded',verification='succeeded',cleanup='succeeded',rollback='not_needed',observed=v['current'],error=None)\n"+
          "u=m.HostUpdater(p,v['config'],inspect=lambda:v['current'],execute=execute);u.assert_model_binding=lambda *args,**_:None\n"+
          "if len(sys.argv)==3 and sys.argv[1]=='--worker':u.worker(sys.argv[2])\n"+
          "else:\n path=p/'socket/update.sock'\n if path.exists():path.unlink()\n server=m.Server(str(path),u);os.chown(path,0,1001);os.chmod(path,0o660);server.serve_forever()\n")
        peer=prefix/'peer.py'
        peer.write_text("import socket,sys,json\ns=socket.socket(socket.AF_UNIX);s.settimeout(8);s.connect(sys.argv[1]);s.sendall((sys.argv[2]+'\\n').encode());raw=b''\nwhile not raw.endswith(b'\\n'):raw+=s.recv(65536)\nprint(raw.decode(),end='')\n")
        def call(frame,uid=1001):
            return json.loads(run([python,'-I',str(peer),str(prefix/'socket/update.sock'),json.dumps(frame)],user=uid,group=1001,extra_groups=[]))
        now=module.dt.datetime.now(module.dt.timezone.utc)
        catalog={'schema':'bellteam.update-catalog.v1','publishedAt':(now-module.dt.timedelta(seconds=10)).isoformat(),
          'expiresAt':(now+module.dt.timedelta(hours=1)).isoformat(),'revokedCatalogs':[],
          'releases':[{'componentId':'container','sourceCommit':'d'*40,'versionId':'sha256:'+'e'*64,'platform':config['platform'],
           'artifact':{'kind':'oci-index','reference':'ghcr.io/kitepon/bellteam-server@sha256:'+'e'*64},
           'compatibility':{'nodeMajor':26,'parentProtocol':None,'stateSchema':None,'containerUpdate':1},'changes':['fixture']}]}
        raw=json.dumps(catalog).encode();digest=hashlib.sha256(raw).hexdigest()
        updater=module.HostUpdater(prefix,config,inspect=lambda:current)
        module.accept_catalog(updater,raw,{'schema':'bellteam.update-catalog.verification.v1','catalogSha256':digest,'catalog':catalog,
          'verification':{'method':'github-oidc-attestation','repositoryId':'1404510084','sourceCommit':'f'*40,'signerCommit':'f'*40,
           'signerWorkflow':'kitepon/BellTeam/.github/workflows/publish-update-catalog.yml'}})
        parser=configparser.ConfigParser(interpolation=None,strict=False)
        template=(ROOT/'distribution/server/updater/bellteam-container-update-host.service.in').read_text()
        parser.read_string(template.replace('/srv/bellteam/shared/tools/bellteam-container-update-host',str(prefix))
          .replace('@PYTHON@',python).replace('@RELEASE@','a'*40))
        front='bellteam-updater-native-front-'+str(uuid.uuid4())
        command=[manager,'--system','--quiet','--collect','--unit='+front]
        for key,value in parser['Service'].items():
            names={name.lower():name for name in ['Type','User','Group','UMask','WorkingDirectory','Environment','StandardInput','NoNewPrivileges',
             'CapabilityBoundingSet','AmbientCapabilities','ProtectSystem','ProtectHome','PrivateTmp','PrivateDevices','ProtectKernelTunables',
             'ProtectKernelModules','ProtectControlGroups','RestrictSUIDSGID','LockPersonality','RestrictAddressFamilies','ReadWritePaths',
             'InaccessiblePaths','KillMode','TimeoutStopSec','Restart','LimitCORE']}
            if key!='execstart':command.append('--property='+names[key]+'='+value)
        command+=shlex.split(parser['Service']['ExecStart'])
        try:
            units.append(front);run(command);wait(lambda:(prefix/'socket/update.sock').exists())
            assert call({'operation':'capabilities','params':{}},uid=0)['error']['status']==403
            assert call({'operation':'capabilities','params':{'env':{}}})['error']['status']==400
            parent_inode=(prefix/'socket').stat().st_ino
            plan_id=str(uuid.uuid4());request_id=str(uuid.uuid4())
            plan=call({'operation':'plan','params':{'planId':plan_id,'catalogSha256':digest,'versionId':'sha256:'+'e'*64}})
            assert plan['ok']
            worker='bellteam-container-update-worker-'+request_id;units.append(worker)
            accepted=call({'operation':'start','params':{'requestId':request_id,'planId':plan_id,'confirmContainerRestart':True}})
            assert accepted['ok'] and accepted['value']['admission']=='accepted'
            record=module.read_json(prefix/'state/operations'/request_id/'operation.json')
            original_birth=record['worker']['birth'];pid=record['worker']['pid']
            front_group=run([systemctl,'show',front,'-p','ControlGroup','--value'])
            worker_group=run([systemctl,'show',worker,'-p','ControlGroup','--value'])
            assert front_group and worker_group and front_group!=worker_group
            run([systemctl,'stop',front]);assert module.birth(pid)==original_birth
            assert run([systemctl,'is-active',worker])=='active'
            (prefix/'state/release-worker').touch()
            def complete():
                return module.read_json(prefix/'state/operations'/request_id/'operation.json')['phase']=='completed'
            wait(complete)
            old_front=front;front='bellteam-updater-native-front-'+str(uuid.uuid4());units.append(front)
            command=[arg.replace('--unit='+old_front,'--unit='+front) for arg in command]
            run(command)
            def reconnected():
                try:return call({'operation':'capabilities','params':{}}).get('ok') is True
                except (OSError,subprocess.SubprocessError,ValueError):return False
            wait(reconnected)
            result=call({'operation':'get','params':{'requestId':request_id}})
            assert result['ok'] and result['value']['requestId']==request_id and result['value']['phase']=='completed'
            assert (prefix/'socket').stat().st_ino==parent_inode
            print(json.dumps({'schema':'bellteam.host-updater.systemd-fixture.v1','realSystemd':True,'peer1001':True,
                'separateCgroup':True,'workerSurvivedFrontendStop':True,'sameRequestReadback':True,'socketParentRetained':True,
                'realDocker':False,'realSignature':False,'productionEntrypoint':False}))
        finally:
            for unit in reversed(units):
                subprocess.run([systemctl,'stop',unit],env=ENV,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10)
            for root,_,_ in os.walk(prefix):os.chmod(root,0o700)

if __name__=='__main__':main()
