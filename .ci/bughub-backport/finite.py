#!/usr/bin/env python3
"""Manual candidate only: fixed main context, native build, delta probe, immutable binding."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import time
import urllib.request

BASE=Path(__file__).resolve().parent
OUT=BASE/'output'
ROOT=BASE.parents[1]
ACCEPTED='3cb6ffe0f3f5ac93bd293428d0f53fdfcb24a1f3'
REPO='ghcr.io/kitepon/bellteam-server'
BRANCH='refs/heads/ci/centi-security-image-20261026'
UNKNOWN=False
DEADLINE=0
STATE={}

def save():
    (OUT/'state.json').write_text(json.dumps(STATE,indent=2)+'\n')

def source(value):
    if not re.fullmatch('[0-9a-f]{40}',value):raise ValueError('EXACT_SOURCE_REQUIRED')
    return value

def tag(commit,run,arch=None):
    source(commit)
    if not re.fullmatch('[0-9]+',run):raise ValueError('RUN_REQUIRED')
    if arch not in [None,'amd64','arm64']:raise ValueError('ARCH_REQUIRED')
    return REPO+':security-'+commit+'-'+run+('-'+arch if arch else '')

def environment(auth=False):
    env={'PATH':os.environ['PATH'],'HOME':str(OUT/'private/home'),'TMPDIR':str(OUT/'private/tmp'),
         'DOCKER_CONFIG':str(OUT/'private/docker-empty'),'LANG':'C.UTF-8'}
    if auth:
        p=Path(os.environ['DOCKER_CONFIG']).resolve();parent=Path(os.environ['RUNNER_TEMP']).resolve()
        if p.parent!=parent or p.name!='security-registry-auth':raise ValueError('AUTH_PATH_REFUSED')
        env['DOCKER_CONFIG']=str(p)
    return env

def command(argv,seconds,*,auth=False,cleanup=False):
    global UNKNOWN
    if UNKNOWN:raise ValueError('UNKNOWN_NO_MORE_DOCKER')
    left=min(seconds,int(DEADLINE-time.monotonic())-(0 if cleanup else 60))
    if left<=0:raise ValueError('DEADLINE')
    n=len(STATE.setdefault('commands',[]));rec={'argv':argv,'limit':left,'startedAt':time.time()};STATE['commands'].append(rec);save()
    out=OUT/f'{n:02}.stdout.log';err=OUT/f'{n:02}.stderr.log'
    with out.open('wb') as stdout,err.open('wb') as stderr:
        child=subprocess.Popen(['timeout','--signal=TERM','--kill-after=5s',str(left)+'s',*argv],cwd=ROOT,env=environment(auth),stdout=stdout,stderr=stderr)
        try:
            rec['wrapperPid']=child.pid;save();rec['exitCode']=child.wait()
        except Exception:
            UNKNOWN=True;STATE['unknown']=True
            try:save()
            except Exception:pass
            raise
        rec['finishedAt']=time.time();save()
    if rec['exitCode'] in [124,137] or rec['exitCode']<0:UNKNOWN=True;STATE['unknown']=True;save();raise ValueError('CLIENT_TIMEOUT_UNKNOWN')
    if rec['exitCode']:raise ValueError('COMMAND_FAILED_'+str(n))
    return out

def projection():
    fields={'id':'.Id','image':'.Image','name':'.Name','labels':'.Config.Labels','user':'.Config.User','entry':'.Config.Entrypoint','args':'.Config.Cmd','mounts':'.Mounts','state':'.State','memory':'.HostConfig.Memory','swap':'.HostConfig.MemorySwap','cpus':'.HostConfig.NanoCpus','pids':'.HostConfig.PidsLimit','ro':'.HostConfig.ReadonlyRootfs','network':'.HostConfig.NetworkMode','capDrop':'.HostConfig.CapDrop','security':'.HostConfig.SecurityOpt','tmpfs':'.HostConfig.Tmpfs'}
    return '{'+','.join(json.dumps(k)+':{{json '+v+'}}' for k,v in fields.items())+'}'

def valid_inspect(d,cid,image,name,run,probe):
    if (d['id']!=cid or d['image']!=image or d['name']!='/'+name or
        d['labels'].get('centi.security')!=run or d['user']!='1000:1000' or
        d['entry']!=['node'] or d['args']!=['--max-old-space-size=256','/app/test/probe.mjs'] or
        (d['memory'],d['swap'],d['cpus'],d['pids'],d['ro'],d['network'])!=(2147483648,2147483648,1000000000,512,True,'none') or
        d['capDrop']!=['ALL'] or d['security']!=['no-new-privileges:true'] or
        d['tmpfs']!={'/tmp':'rw,noexec,nosuid,size=67108864,mode=1777'}):raise ValueError('FIXTURE_IDENTITY_CAPS')
    mounts=d['mounts']
    if len(mounts)!=1 or any(mounts[0].get(k)!=v for k,v in {'Type':'bind','Source':str(probe),'Destination':'/app/test','RW':False}.items()):raise ValueError('FIXTURE_MOUNT')
    if d['state']['Status'] not in ['created','exited'] or d['state']['Running']:raise ValueError('FIXTURE_NOT_STOPPED')

def raw_request(url,headers=None):
    left=DEADLINE-time.monotonic()
    if left<=0:raise ValueError('REGISTRY_DEADLINE')
    chunks=[];size=0
    with urllib.request.urlopen(urllib.request.Request(url,headers=headers or {}),timeout=min(30,left)) as response:
        while True:
            if time.monotonic()>=DEADLINE:raise ValueError('REGISTRY_DEADLINE')
            part=response.read1(65536)
            if not part:break
            size+=len(part)
            if size>8*1024*1024:raise ValueError('REGISTRY_METADATA_SIZE')
            chunks.append(part)
    data=b''.join(chunks)
    if len(data)>8*1024*1024:raise ValueError('REGISTRY_METADATA_SIZE')
    return data

def registry_binding(reference,prefix,commit,expected_arch=None):
    token=json.loads(raw_request('https://ghcr.io/token?service=ghcr.io&scope=repository:kitepon/bellteam-server:pull'))['token']
    headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json,application/vnd.docker.distribution.manifest.list.v2+json'}
    raw=raw_request('https://ghcr.io/v2/kitepon/bellteam-server/manifests/'+reference,headers);digest='sha256:'+hashlib.sha256(raw).hexdigest()
    if reference.startswith('sha256:') and reference!=digest:raise ValueError('REGISTRY_DIGEST_MISMATCH')
    (OUT/(prefix+'-manifest.json')).write_bytes(raw);data=json.loads(raw)
    if expected_arch:
        config_id=data['config']['digest'];config=raw_request('https://ghcr.io/v2/kitepon/bellteam-server/blobs/'+config_id,headers)
        if 'sha256:'+hashlib.sha256(config).hexdigest()!=config_id:raise ValueError('CONFIG_DIGEST_MISMATCH')
        (OUT/(prefix+'-config.json')).write_bytes(config);cfg=json.loads(config)
        if cfg['architecture']!=expected_arch or cfg['os']!='linux' or cfg['config']['Labels']['org.opencontainers.image.revision']!=commit:raise ValueError('CONFIG_SOURCE_ARCH')
        return {'digest':digest,'config':config_id,'architecture':expected_arch}
    return {'digest':digest,'manifests':data['manifests']}

def prepare(commit):
    product=ROOT/'runtime/security-product'
    command(['git','merge-base','--is-ancestor',ACCEPTED,commit],20)
    head=command(['git','rev-parse','origin/main'],20).read_text().strip()
    if head!=commit:raise ValueError('EXACT_MAIN_REQUIRED')
    msg=command(['git','show','-s','--format=%B',commit],20).read_text()
    if '[skip ci]' not in msg:raise ValueError('ROOT_MERGE_SKIP_CI_MISSING')
    command(['git','worktree','add','--detach',str(product),commit],30)
    command(['node',str(product/'scripts/package-server.mjs'),str(OUT/'context')],60)
    baseline=json.loads((BASE/'context-files.json').read_text());files={str(f.relative_to(OUT/'context')):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted((OUT/'context').rglob('*')) if f.is_file()}
    distribution=json.loads((OUT/'context/distribution.json').read_text())
    if distribution!={'schema':'bellteam.server.distribution.v1','sourceCommit':commit,'profile':'public'}:raise ValueError('PUBLIC_SOURCE')
    compare=dict(files);compare['distribution.json']=baseline['files']['distribution.json']
    if compare!=baseline['files']:raise ValueError('ACCEPTED_CONTEXT_DRIFT')
    probe=OUT/'probe';probe.mkdir();shutil.copyfile(BASE/'probe.mjs',probe/'probe.mjs')
    guard=product/'test/seat-mcp-input-limit.test.mjs'
    if hashlib.sha256(guard.read_bytes()).hexdigest()!='19fc81bd67246158bf115aa9dda7721c2cc189d0d4e7ef67301da017780493da':raise ValueError('GUARD_SOURCE')
    shutil.copyfile(guard,probe/guard.name);(probe/'context-files.json').write_text(json.dumps({'source':commit,'files':files})+'\n')
    STATE.update(contextFiles=files,productSource=commit);save();return probe

def build(commit,arch,run):
    global UNKNOWN
    if platform.machine()!={'amd64':'x86_64','arm64':'aarch64'}[arch]:raise ValueError('NATIVE_ARCH_REQUIRED')
    mem=int(re.search(r'^MemAvailable:\s+(\d+)',Path('/proc/meminfo').read_text(),re.M)[1])*1024
    docker_root=json.loads(command(['docker','info','--format','{{json .DockerRootDir}}'],20).read_text())
    free=shutil.disk_usage(docker_root).free;STATE['initialResources']={'memAvailable':mem,'dockerFree':free};save()
    if mem<4*1024**3 or free<40*1024**3:raise ValueError('BUILD_HEADROOM')
    probe=prepare(commit);image_tag=tag(commit,run,arch)
    command(['docker','build','--pull','--no-cache','--platform','linux/'+arch,'--label','org.opencontainers.image.source=https://github.com/kitepon/BellTeam','--label','org.opencontainers.image.revision='+commit,'-t',image_tag,str(OUT/'context')],2100)
    image=command(['docker','image','inspect','--format','{{.Id}}',image_tag],20).read_text().strip()
    if not re.fullmatch('sha256:[0-9a-f]{64}',image):raise ValueError('IMAGE_ID')
    name='centi-security-'+run+'-'+arch
    STATE.update(image=image,tag=image_tag,fixtureName=name,probe=str(probe),removed=False);save()
    cid=command(['docker','create','--name',name,'--label','centi.security='+run,'--user','1000:1000','--memory','2147483648','--memory-swap','2147483648','--cpus','1','--pids-limit','512','--read-only','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp:rw,noexec,nosuid,size=67108864,mode=1777','--mount','type=bind,src='+str(probe)+',dst=/app/test,readonly','--entrypoint','node',image,'--max-old-space-size=256','/app/test/probe.mjs'],30).read_text().strip()
    if not re.fullmatch('[a-f0-9]{64}',cid):
        UNKNOWN=True;STATE['unknown']=True;save();raise ValueError('UNKNOWN_CREATED_CID')
    STATE.update(cid=cid,image=image,tag=image_tag,fixtureName=name,probe=str(probe),removed=False);save()
    before=json.loads(command(['docker','inspect','--format',projection(),cid],20).read_text());valid_inspect(before,cid,image,name,run,probe)
    output=command(['docker','start','-a',cid],420)
    after=json.loads(command(['docker','inspect','--format',projection(),cid],20).read_text());valid_inspect(after,cid,image,name,run,probe)
    if after['state']['ExitCode']!=0 or after['state']['OOMKilled']:raise ValueError('PROBE_EXIT_OR_OOM')
    lines=output.read_text().splitlines();inventory=json.loads(lines[0]);completed=json.loads(lines[-1])
    if inventory['stage']!='runtime-inventory' or inventory['sdk']!='1.32.2' or completed['stage']!='guard-complete' or completed['pass']!=3:raise ValueError('PROBE_INCOMPLETE')
    (OUT/'runtime-inventory.json').write_text(json.dumps(inventory)+'\n');(OUT/'guard-result.json').write_text(json.dumps(completed)+'\n');STATE['probeAccepted']=True;save()

def cleanup(run):
    if UNKNOWN or not STATE.get('cid') or STATE.get('removed'):return
    cid=STATE['cid'];d=json.loads(command(['docker','inspect','--format',projection(),cid],20,cleanup=True).read_text())
    valid_inspect(d,cid,STATE['image'],STATE['fixtureName'],run,Path(STATE['probe']))
    command(['docker','rm',cid],20,cleanup=True);STATE['removed']=True;save()
    listed=command(['docker','ps','-a','--filter','id='+cid,'--format','{{.ID}}'],15,cleanup=True).read_text().strip()
    if listed:raise ValueError('FIXTURE_REMAINS')
    STATE['absenceConfirmed']=True;save()

def publish(commit,arch,run):
    if not STATE.get('probeAccepted') or not STATE.get('absenceConfirmed'):raise ValueError('NO_PROBE_OR_CLEANUP')
    if command(['docker','image','inspect','--format','{{.Id}}',STATE['tag']],20).read_text().strip()!=STATE['image']:raise ValueError('LOCAL_TAG_DRIFT')
    command(['docker','push',STATE['tag']],180,auth=True)
    binding=registry_binding(STATE['tag'].split(':')[-1],arch,commit,arch)
    if binding['config']!=STATE['image']:raise ValueError('PUSH_CONFIG_DRIFT')
    (OUT/'published.json').write_text(json.dumps({'source':commit,'tag':STATE['tag'],**binding},indent=2)+'\n')

def index(commit,run):
    rows=[json.loads(p.read_text()) for p in sorted((ROOT/'incoming').rglob('published.json'))]
    if len(rows)!=2 or {r['architecture'] for r in rows}!={'amd64','arm64'} or any(r['source']!=commit for r in rows):raise ValueError('TWO_ARCH_BINDINGS_REQUIRED')
    for row in rows:
        if row['tag']!=tag(commit,run,row['architecture']) or not re.fullmatch('sha256:[a-f0-9]{64}',row['digest']):raise ValueError('ARCH_TAG_OR_DIGEST')
        prior=registry_binding(row['digest'],'pre-'+row['architecture'],commit,row['architecture'])
        if prior['config']!=row['config']:raise ValueError('PRE_INDEX_CONFIG')
    index_tag=tag(commit,run)
    command(['docker','buildx','imagetools','create','-t',index_tag,*[REPO+'@'+r['digest'] for r in rows]],120,auth=True)
    binding=registry_binding(index_tag.split(':')[-1],'index',commit)
    expected={r['architecture']:r['digest'] for r in rows};actual={x['platform']['architecture']:x['digest'] for x in binding['manifests']}
    if actual!=expected:raise ValueError('INDEX_ARCH_DIGEST')
    for r in rows:
        child=registry_binding(r['digest'],r['architecture'],commit,r['architecture'])
        if child['config']!=r['config']:raise ValueError('INDEX_CONFIG')
    (OUT/'candidate-binding.json').write_text(json.dumps({'source':commit,'tag':index_tag,'image':REPO+'@'+binding['digest'],'architectures':rows,'acceptedScope':'candidate build/context/SDK guard/inventory only; no production acceptance'},indent=2)+'\n')

def main():
    global STATE,DEADLINE
    mode=sys.argv[1];arch=sys.argv[2] if len(sys.argv)==3 else None
    commit=source(os.environ.get('PRODUCT_SOURCE',''));run=os.environ['GITHUB_RUN_ID']
    if os.environ.get('GITHUB_REF')!=BRANCH or os.environ.get('GITHUB_EVENT_NAME')!='workflow_dispatch' or os.environ.get('GITHUB_RUN_ATTEMPT')!='1' or os.environ.get('CI_RUNNER_ENVIRONMENT')!='github-hosted':raise ValueError('MANUAL_HOSTED_ATTEMPT1_ONLY')
    OUT.mkdir(parents=True,exist_ok=True)
    for name in ['home','tmp','docker-empty']:(OUT/'private'/name).mkdir(parents=True,exist_ok=True)
    if mode not in ['build','publish','index']:raise ValueError('MODE')
    if mode in ['build','publish'] and arch not in ['amd64','arm64']:raise ValueError('ARCH')
    with (OUT/(mode+'.claim')).open('x') as claim:claim.write(str(time.time()))
    STATE=json.loads((OUT/'state.json').read_text()) if mode=='publish' else {'commands':[],'mode':mode,'source':commit,'run':run,'unknown':False}
    if mode=='publish' and (STATE.get('source')!=commit or STATE.get('run')!=run or STATE.get('tag')!=tag(commit,run,arch) or STATE.get('unknown')):raise ValueError('PUBLISH_STATE_IDENTITY')
    DEADLINE=time.monotonic()+({'build':2700,'publish':240,'index':420}[mode])
    try:
        if mode=='build':build(commit,arch,run);cleanup(run)
        elif mode=='publish':publish(commit,arch,run)
        else:index(commit,run)
        STATE['modeSucceeded']=mode
    except Exception as error:
        STATE['failureType']=type(error).__name__;STATE['failure']=str(error) if isinstance(error,ValueError) else 'FAILED'
        if mode=='build' and not UNKNOWN:
            try:cleanup(run)
            except Exception as cleanup_error:STATE['cleanupUnconfirmed']=type(cleanup_error).__name__
        raise
    finally:
        save();refs=[{'path':str(p.relative_to(OUT)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in OUT.rglob('*') if p.is_file() and 'private' not in p.relative_to(OUT).parts and 'context' not in p.relative_to(OUT).parts and 'probe' not in p.relative_to(OUT).parts and p.name!='artifact-index.json'];(OUT/'artifact-index.json').write_text(json.dumps(refs,indent=2)+'\n')
if __name__=='__main__':main()
