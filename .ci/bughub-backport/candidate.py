"""One approved backport candidate; inherited immutable layers, no product rebuild."""
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import shutil
import sys
import tarfile
import time

import finite as f

BASE = Path(__file__).resolve().parent
PLAN = json.loads((BASE/'plan.json').read_text())
SOURCE = PLAN['backportSource']
MODULE = 'src/bughub-security.mjs'


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def tag(run, arch=None):
    if not re.fullmatch('[0-9]+', run) or arch not in (None, 'amd64', 'arm64'):
        raise ValueError('FIXED_RUN_ARCH')
    return f.REPO+':bughub-'+SOURCE+'-'+run+('-'+arch if arch else '')


def labels(original):
    return dict(original or {}, **{
        'org.opencontainers.image.revision': SOURCE,
        'org.opencontainers.image.base.name': f.REPO,
        'org.opencontainers.image.base.digest': PLAN['base'].split('@')[1]})


def config_delta(base, new):
    if new['rootfs']['diff_ids'][:-1] != base['rootfs']['diff_ids']:
        raise ValueError('BASE_DIFF_IDS_CHANGED')
    if len(new['rootfs']['diff_ids']) != len(base['rootfs']['diff_ids'])+1:
        raise ValueError('ONE_FILE_LAYER_REQUIRED')
    if new['history'][:len(base['history'])] != base['history']:
        raise ValueError('BASE_HISTORY_CHANGED')
    left, right = dict(base), dict(new)
    for value in (left, right):
        for key in ('created', 'history', 'rootfs'):
            value.pop(key, None)
        value['config'] = dict(value['config'])
    left['config']['Labels'] = labels(base['config'].get('Labels'))
    if left != right:
        raise ValueError('UNRELATED_IMAGE_CONFIG_CHANGED')


def one_file_layer(raw):
    seen = []
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:*') as archive:
        for member in archive:
            name = member.name.removeprefix('./').rstrip('/')
            if member.isdir() and name in ('app', 'app/src'):
                if (member.uid, member.gid, member.mode) != (0, 0, 0o755):
                    raise ValueError('PARENT_METADATA_CHANGED')
                continue
            if (name != 'app/'+MODULE or not member.isfile()
                    or (member.uid, member.gid, member.mode) != (0, 0, 0o644)
                    or member.size > 65536):
                raise ValueError('UNRELATED_LAYER_MEMBER')
            if digest(archive.extractfile(member).read()) != PLAN['moduleSHA256']:
                raise ValueError('MODULE_BYTES_CHANGED')
            seen.append(name)
    if seen != ['app/'+MODULE]:
        raise ValueError('EXACTLY_ONE_MODULE_REQUIRED')


def registry(reference, prefix, revision, arch=None):
    return f.registry_binding(reference, prefix, revision, arch)


def base_binding(arch):
    row = PLAN['baseBinding']['architectures'][arch]
    registry(PLAN['base'].split('@')[1], 'base-index', PLAN['baseSource'])
    bound = registry(row['manifest'], 'base-'+arch, PLAN['baseSource'], arch)
    if bound['config'] != row['config']:
        raise ValueError('BASE_CONFIG_DRIFT')
    return row


def source_check():
    if digest((BASE/'finite.py').read_bytes()) != PLAN['finiteHelperSHA256']:
        raise ValueError('FINITE_HELPER_CHANGED')
    if digest((BASE/'patched-module.mjs').read_bytes()) != PLAN['moduleSHA256']:
        raise ValueError('PATCH_INPUT_CHANGED')
    if digest((BASE/'base-module.mjs').read_bytes()) != PLAN['baseModuleSHA256']:
        raise ValueError('BASE_INPUT_CHANGED')
    paths = f.command(['git','diff','--name-only',PLAN['baseSource'],SOURCE],20).read_text().splitlines()
    if paths != [MODULE]:
        raise ValueError('BACKPORT_SOURCE_SCOPE')
    for revision, expected in ((PLAN['baseSource'], PLAN['baseModuleSHA256']),
                               (SOURCE, PLAN['moduleSHA256'])):
        if digest(f.command(['git','show',revision+':'+MODULE],20).read_bytes()) != expected:
            raise ValueError('BACKPORT_SOURCE_BYTES')


def probe(image, run, arch, patched):
    folder = f.OUT/('probe-patched' if patched else 'probe-base')
    folder.mkdir()
    for name in ('probe.mjs','base-module.mjs'):
        shutil.copyfile(BASE/name, folder/name)
    config = json.loads((f.OUT/('base-'+arch+'-config.json')).read_text())
    (folder/'expected.json').write_text(json.dumps({
        'patched':patched, 'moduleSHA256':PLAN['moduleSHA256'] if patched else PLAN['baseModuleSHA256'],
        'baseEnv':config['config']['Env']})+'\n')
    name = 'centi-bughub-'+run+'-'+arch+('-patched' if patched else '-base')
    f.STATE.update(cid=None, removed=False, absenceConfirmed=False, fixtureName=name,
                   image=image, probe=str(folder))
    f.save()
    cid = f.command(['docker','create','--name',name,'--label','centi.security='+run,
        '--user','1000:1000','--memory','2147483648','--memory-swap','2147483648',
        '--cpus','1','--pids-limit','512','--read-only','--network','none','--cap-drop','ALL',
        '--security-opt','no-new-privileges:true','--tmpfs','/tmp:rw,noexec,nosuid,size=67108864,mode=1777',
        '--env','HOME=/tmp/empty-home','--env','DOCKER_CONFIG=/tmp/empty-docker-config',
        '--mount','type=bind,src='+str(folder)+',dst=/app/test,readonly','--entrypoint','node',
        image,'--max-old-space-size=256','/app/test/probe.mjs'],30).read_text().strip()
    if not re.fullmatch('[a-f0-9]{64}', cid):
        f.UNKNOWN=True; f.STATE['unknown']=True; f.save()
        raise ValueError('UNKNOWN_CREATED_CID')
    f.STATE['cid']=cid; f.save()
    def inspect():
        value=json.loads(f.command(['docker','inspect','--format',f.projection(),cid],20).read_text())
        f.valid_inspect(value,cid,image,name,run,folder)
        return value
    inspect()
    output=f.command(['docker','start','-a',cid],60)
    after=inspect()
    if after['state']['ExitCode'] != 0 or after['state']['OOMKilled']:
        raise ValueError('PROBE_TERMINAL')
    result=json.loads(output.read_text())
    if result != {'stage':'bughub-metadata-only','patched':patched,'moduleSHA256':
            PLAN['moduleSHA256'] if patched else PLAN['baseModuleSHA256'],'serviceCalls':0}:
        raise ValueError('PROBE_RESULT')
    (f.OUT/('patched-probe.json' if patched else 'base-probe.json')).write_text(json.dumps(result)+'\n')
    f.cleanup(run)
    if not f.STATE.get('absenceConfirmed'):
        raise ValueError('OWNED_CLEANUP_REQUIRED')


def build(arch, run):
    if platform.machine() != {'amd64':'x86_64','arm64':'aarch64'}[arch]:
        raise ValueError('NATIVE_ARCH_REQUIRED')
    source_check()
    row=base_binding(arch)
    mem=int(re.search(r'^MemAvailable:\s+(\d+)',Path('/proc/meminfo').read_text(),re.M)[1])*1024
    docker_root=json.loads(f.command(['docker','info','--format','{{json .DockerRootDir}}'],20).read_text())
    if mem < 4*1024**3 or shutil.disk_usage(docker_root).free < 40*1024**3:
        raise ValueError('CI_HEADROOM')
    f.command(['docker','pull',f.REPO+'@'+row['manifest']],600)
    probe(row['config'],run,arch,False)
    context=f.OUT/'context'; context.mkdir()
    shutil.copyfile(BASE/'patched-module.mjs',context/'bughub-security.mjs')
    text='FROM '+f.REPO+'@'+row['manifest']+'\nCOPY --chown=0:0 --chmod=0644 bughub-security.mjs /app/src/bughub-security.mjs\n'
    text+='LABEL '+ ' '.join(k+'='+json.dumps(v) for k,v in labels({}).items())+'\n'
    (context/'Dockerfile').write_text(text)
    target=tag(run,arch)
    f.command(['docker','build','--pull=false','--no-cache','--platform','linux/'+arch,'-t',target,str(context)],300)
    local=json.loads(f.command(['docker','image','inspect','--format','{{json .}}',target],20).read_text())
    base=json.loads((f.OUT/('base-'+arch+'-config.json')).read_text())
    if local['RootFS']['Layers'][:-1] != base['rootfs']['diff_ids'] or len(local['RootFS']['Layers']) != len(base['rootfs']['diff_ids'])+1:
        raise ValueError('LOCAL_BASE_LAYERS_CHANGED')
    for key,value in base['config'].items():
        if local['Config'].get(key) != (labels(value) if key=='Labels' else value):
            raise ValueError('LOCAL_CONFIG_CHANGED')
    probe(local['Id'],run,arch,True)
    f.STATE.update(tag=target,image=local['Id'],probeAccepted=True,baseLayersUnchanged=True)
    f.save()


def publish(arch,run):
    if not f.STATE.get('probeAccepted') or not f.STATE.get('absenceConfirmed') or not f.STATE.get('baseLayersUnchanged'):
        raise ValueError('PROBE_AND_CLEANUP_REQUIRED')
    if f.command(['docker','image','inspect','--format','{{.Id}}',tag(run,arch)],20).read_text().strip()!=f.STATE['image']:
        raise ValueError('LOCAL_TAG_CHANGED')
    f.command(['docker','push',tag(run,arch)],180,auth=True)
    bound=registry(tag(run,arch).split(':')[-1],arch,SOURCE,arch)
    if bound['config'] != f.STATE['image']:
        raise ValueError('PUBLISHED_CONFIG_CHANGED')
    base=json.loads((f.OUT/('base-'+arch+'-manifest.json')).read_text())
    new=json.loads((f.OUT/(arch+'-manifest.json')).read_text())
    if new['layers'][:-1] != base['layers'] or len(new['layers']) != len(base['layers'])+1:
        raise ValueError('PUBLISHED_BASE_LAYERS_CHANGED')
    config_delta(json.loads((f.OUT/('base-'+arch+'-config.json')).read_text()),
                 json.loads((f.OUT/(arch+'-config.json')).read_text()))
    token=json.loads(f.raw_request('https://ghcr.io/token?service=ghcr.io&scope=repository:kitepon/bellteam-server:pull'))['token']
    layer=new['layers'][-1]['digest']
    raw=f.raw_request('https://ghcr.io/v2/kitepon/bellteam-server/blobs/'+layer,{'Authorization':'Bearer '+token})
    if 'sha256:'+digest(raw) != layer:
        raise ValueError('NEW_LAYER_DIGEST')
    one_file_layer(raw)
    (f.OUT/'published.json').write_text(json.dumps({'source':SOURCE,'base':PLAN['base'],
        'ciHead':f.STATE['ciHead'],'tag':tag(run,arch),'moduleSHA256':PLAN['moduleSHA256'],'newLayerVerified':True,**bound},indent=2)+'\n')


def index(run):
    rows=[json.loads(p.read_text()) for p in sorted((f.ROOT/'incoming').rglob('published.json'))]
    if len(rows)!=2 or {r['architecture'] for r in rows}!={'amd64','arm64'}:
        raise ValueError('TWO_ARCH_REQUIRED')
    for row in rows:
        if (row['source']!=SOURCE or row['base']!=PLAN['base'] or not row['newLayerVerified']
                or row['ciHead']!=os.environ['GITHUB_SHA']
                or row['moduleSHA256']!=PLAN['moduleSHA256'] or row['tag']!=tag(run,row['architecture'])):
            raise ValueError('ARCH_BINDING')
        before=registry(row['digest'],'pre-'+row['architecture'],SOURCE,row['architecture'])
        if before['config']!=row['config']:raise ValueError('ARCH_CONFIG')
    f.command(['docker','buildx','imagetools','create','-t',tag(run),*[f.REPO+'@'+r['digest'] for r in rows]],120,auth=True)
    result=registry(tag(run).split(':')[-1],'index',SOURCE)
    if {x['platform']['architecture']:x['digest'] for x in result['manifests']}!={r['architecture']:r['digest'] for r in rows}:
        raise ValueError('INDEX_BINDING')
    for row in rows:registry(row['digest'],row['architecture'],SOURCE,row['architecture'])
    (f.OUT/'candidate-binding.json').write_text(json.dumps({'source':SOURCE,'base':PLAN['base'],
        'image':f.REPO+'@'+result['digest'],'architectures':rows,'productionReady':False},indent=2)+'\n')


def main():
    mode=sys.argv[1];arch=sys.argv[2] if len(sys.argv)==3 else None;run=os.environ['GITHUB_RUN_ID']
    if (os.environ.get('GITHUB_REF')!=PLAN['branch'] or os.environ.get('GITHUB_RUN_ATTEMPT')!='1'
            or os.environ.get('GITHUB_EVENT_NAME')!='workflow_dispatch'
            or os.environ.get('CI_RUNNER_ENVIRONMENT')!='github-hosted'):
        raise ValueError('MANUAL_HOSTED_ATTEMPT1')
    if os.environ.get('BACKPORT_SOURCE')!=SOURCE:
        raise ValueError('EXACT_BACKPORT_SOURCE')
    if mode not in ('build','publish','index') or (mode!='index' and arch not in ('amd64','arm64')):
        raise ValueError('MODE_ARCH')
    f.OUT=BASE/'output';f.ROOT=BASE.parents[1];f.OUT.mkdir(exist_ok=True)
    shutil.copyfile(BASE/'plan.json',f.OUT/'plan.json')
    for name in ('home','tmp','docker-empty'):(f.OUT/'private'/name).mkdir(parents=True,exist_ok=True)
    with (f.OUT/(mode+'.claim')).open('x') as claim:claim.write(run)
    f.STATE=json.loads((f.OUT/'state.json').read_text()) if mode=='publish' else {'run':run,'source':SOURCE,'ciHead':os.environ['GITHUB_SHA'],'commands':[],'unknown':False}
    if (f.STATE.get('unknown') or f.STATE.get('run')!=run or f.STATE.get('source')!=SOURCE
            or f.STATE.get('ciHead')!=os.environ['GITHUB_SHA']):
        raise ValueError('STATE_IDENTITY')
    f.DEADLINE=time.monotonic()+{'build':1200,'publish':240,'index':420}[mode]
    try:
        if mode=='build':build(arch,run)
        elif mode=='publish':publish(arch,run)
        else:index(run)
    except Exception:
        if mode=='build' and not f.UNKNOWN:
            try:f.cleanup(run)
            except Exception as error:f.STATE['cleanupUnconfirmed']=type(error).__name__
        raise
    finally:
        f.save()
        refs=[{'path':p.name,'sha256':digest(p.read_bytes())} for p in sorted(f.OUT.iterdir()) if p.is_file() and p.name!='artifact-index.json']
        (f.OUT/'artifact-index.json').write_text(json.dumps(refs,indent=2)+'\n')


if __name__=='__main__':main()
