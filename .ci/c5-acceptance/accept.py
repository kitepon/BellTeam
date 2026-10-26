"""One fixed candidate, observed sequential stages. No execution without the host gate."""
import datetime,hashlib,json,os,pathlib,re,subprocess,tarfile,time,sys,shutil,platform,urllib.request
from phase_guard import Held,configured_ok
BASE=pathlib.Path(__file__).resolve().parent
ROOT=BASE/'output';ROOT.mkdir(exist_ok=True)
STATE_PATH=ROOT/'state.json';DOCKER_ROOT=ROOT
PLAN=json.loads((BASE/'plan.json').read_text());REG=json.loads((BASE/'registry.json').read_text())
PLAN['allowedRefs']=['ghcr.io/kitepon/bellteam-server@'+x['manifest_digest'] for x in REG['architectures'].values()]
ENV={**os.environ,'DOCKER_CONFIG':str(ROOT/'anonymous-docker')};pathlib.Path(ENV['DOCKER_CONFIG']).mkdir(exist_ok=True)
def utc():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def ticks(pid):
 try:return int(pathlib.Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()[19])
 except (OSError,ValueError,IndexError):return None
STATE={'schemaVersion':1,'run':PLAN['run'],'image':PLAN['image'],'updatedAt':utc(),'phase':'prepare','phaseStatus':'prepared','hostRunnerPid':os.getpid(),'hostRunnerStartTicks':ticks(os.getpid()),'containers':[],'commands':[],'phaseEvents':[]}
REPORT={'run':PLAN['run'],'image':PLAN['image'],'architectures':{}};deadline=None;phase_deadline=None;current='prepare';seq=0;owns_state=False
class UnknownCompletion(Held):pass
def atomic(path,value):
 tmp=path.with_suffix(path.suffix+'.tmp');tmp.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n');tmp.replace(path)
def save():STATE['updatedAt']=utc();atomic(STATE_PATH,STATE)
def resource_values(available,disk,start):
 limits=PLAN['ci'];gib=2**30
 if available<(limits['startAvailableGiB'] if start else limits['runningAvailableGiB'])*gib:raise Held('CI memory headroom')
 if disk<(limits['startDiskGiB'] if start else limits['runningDiskGiB'])*gib:raise Held('CI disk headroom')
 return True
def resources(start=False):
 values={line.split(':')[0]:line.split(':')[1].strip() for line in pathlib.Path('/proc/meminfo').read_text().splitlines()}
 available=int(values['MemAvailable'].split()[0])*1024;disk=shutil.disk_usage(DOCKER_ROOT).free
 resource_values(available,disk,start);return {'observedAt':utc(),'memAvailableBytes':available,'diskFreeBytes':disk,'startThreshold':start}
def check(cleanup=False):
 now=time.time()
 if deadline and now>=deadline-(0 if cleanup else 30):raise Held('CI deadline/cleanup reserve')
 if phase_deadline and now>=phase_deadline:raise Held('phase deadline')
 return resources()
def inspect(cid):return json.loads(subprocess.check_output(['docker','inspect',cid],env=ENV,text=True,timeout=10))[0]
def command(args,*,binary=False,stdin=None,cid=None,cleanup=False):
 global seq
 resource_receipt=check(cleanup);seq+=1;out=ROOT/f"cmd-{seq:03d}.{'tar' if binary else 'log'}";err=ROOT/f'cmd-{seq:03d}.stderr';record={'phase':current,'resourceReceipt':resource_receipt,'command':args,'startedAt':utc(),'stdout':out.name,'stderr':err.name}
 with out.open('wb') as fo,err.open('wb') as fe:
  source=open(stdin,'rb') if stdin else subprocess.DEVNULL
  try:p=subprocess.Popen(args,env=ENV,stdin=source,stdout=fo,stderr=fe)
  finally:
   if stdin:source.close()
  record.update(pid=p.pid,startTicks=ticks(p.pid));STATE['commands'].append(record);save();captured=False
  while p.poll() is None:
   if cid and not captured:
    try:
     info=inspect(cid);pid=info['State']['Pid'];row=next(x for x in STATE['containers'] if x['id']==cid)
     if pid:row.update(pid=pid,startTicks=ticks(pid),observedAt=utc());save();captured=True
    except (OSError,subprocess.SubprocessError,ValueError):pass
   if time.time()>=min(phase_deadline,deadline-(0 if cleanup else 30)):
    record.update(completion='unknown-after-deadline',waitExpiredAt=utc());save();raise UnknownCompletion('client still running: '+str(p.pid))
   time.sleep(.1)
  record.update(endedAt=utc(),exitCode=p.returncode,completion='client exited; daemon effects require separate object inspection');save()
  if p.returncode:raise Held('command failure '+str(p.returncode)+': '+str(err.name))
 return out if binary else out.read_text().strip()
def phase(name,fn):
 global current,phase_deadline
 current=name;phase_deadline=min(time.time()+PLAN['phaseSeconds'][name],deadline-(0 if name=='cleanup' else 30));resource_receipt=check(name=='cleanup');STATE.update(phase=name,phaseStatus='running',phaseDeadline=datetime.datetime.fromtimestamp(phase_deadline,datetime.timezone.utc).isoformat());event={'phase':name,'startedAt':utc(),'resourceReceipt':resource_receipt};STATE['phaseEvents'].append(event);save()
 try:fn();event.update(endedAt=utc(),result='finished');STATE['phaseStatus']='finished';save()
 except Exception as e:event.update(endedAt=utc(),result='failed',error=str(e));STATE['phaseStatus']='failed';save();raise

def create(arch,label,runtime=False):
 name=PLAN['fixturePrefix']+'-'+label;ref='ghcr.io/kitepon/bellteam-server@'+REG['architectures'][arch]['manifest_digest']
 args=['docker','create','--platform','linux/'+arch,'--name',name,'--label','centi.run='+PLAN['run'],'--label','centi.owner=bot-8bc1fb5d','--memory','2147483648','--memory-swap','2147483648','--cpus','1','--pids-limit','512','--network','none','--read-only']
 if runtime:args+=['-i','--tmpfs',PLAN['limits']['tmpfs']]
 args+=['--entrypoint','node' if runtime else '/bin/true',ref]
 if runtime:args+=['--input-type=module']
 cid=command(args)
 if not re.fullmatch('[a-f0-9]{64}',cid):raise Held('create CID missing')
 row={'name':name,'id':cid,'pid':None,'startTicks':None,'createdAt':utc(),'image':ref,'requestedLimits':PLAN['limits']};STATE['containers'].append(row);save()
 info=inspect(cid);configured_ok(info,PLAN,name);row['actualHostConfig']={k:info['HostConfig'].get(k) for k in ['Memory','MemorySwap','NanoCpus','PidsLimit','ReadonlyRootfs','NetworkMode']};row['notStarted']=not runtime;save();return row

def remove(row):
 info=inspect(row['id']);configured_ok(info,PLAN,row['name'])
 if info['State']['Running']:raise Held('running fixture retained, no stop')
 row['terminalState']={k:info['State'].get(k) for k in ['Status','ExitCode','OOMKilled','StartedAt','FinishedAt']};row['terminalObservedAt']=utc();save()
 command(['docker','rm',row['id']],cleanup=True);row.update(removedAt=utc(),removed=True,lastPid=row.get('pid'),lastStartTicks=row.get('startTicks'),pid=None,startTicks=None);save()

def archive(row,path):
 file=command(['docker','cp',row['id']+':'+path,'-'],binary=True);rows=[];hashes={}
 with tarfile.open(file,mode='r|') as t:
  for m in t:
   if m.isfile():
    h=hashlib.sha256();f=t.extractfile(m)
    while b:=f.read(1024*1024):h.update(b)
    rows.append([m.name,'file',h.hexdigest()]);hashes[m.name.split('/',1)[1] if '/' in m.name else m.name]=h.hexdigest()
   elif m.issym() or m.islnk():rows.append([m.name,'link',m.linkname])
 rows.sort();file.unlink();summary={'files':len(rows),'sha256':hashlib.sha256(json.dumps(rows,separators=(',',':')).encode()).hexdigest()}
 if path=='/usr/local/lib/node_modules':
  groups={}
  for v in rows:
   parts=v[0].split('/')[1:]
   if parts:groups.setdefault('/'.join(parts[:2]) if parts[0].startswith('@') else parts[0],[]).append(v)
  summary['groups']={k:{'files':len(v),'sha256':hashlib.sha256(json.dumps(v,separators=(',',':')).encode()).hexdigest()} for k,v in groups.items()}
 return hashes,summary

def bytes_check(arch):
 row=create(arch,'bytes-'+arch);context=json.loads((BASE/'context-files.json').read_text());matched=0
 for group in ['src','config','scripts','web','integrations','services','docs','bridge']:
  actual,_=archive(row,'/app/'+group);expected={p[len(group)+1:]:digest for p,digest in context.items() if p.startswith(group+'/')};assert actual==expected,(arch,group);matched+=len(expected)
 for name,digest in context.items():
  if '/' not in name:
   actual,_=archive(row,'/app/'+name);assert list(actual.values())==[digest];matched+=1
 native,_=archive(row,'/usr/local/lib/node_modules/aiterm-mcp')
 with tarfile.open(BASE/'official-aiterm.tgz') as t:expected={m.name.removeprefix('package/'):hashlib.sha256(t.extractfile(m).read()).hexdigest() for m in t if m.isfile()}
 assert len(expected)==127 and all(native[k]==v for k,v in expected.items())
 _,deps=archive(row,'/app/node_modules');prev=json.loads((BASE/'previous-extra-payload-identity.json').read_text())[arch]['candidate']['appDependencies'];assert deps=={'files':prev['entries'],'sha256':prev['sha256']}
 result={'contextMatched':matched,'nativeOfficialMatched':127,'nativeJS':119,'appDependencies':deps,'notStarted':True,'peak':'not observed: fixture not started'};assert matched==139
 if arch=='arm64':
  old=json.loads((BASE/'previous-arm-cli-bytes-comparison.json').read_text())['images']['candidate'];trees={}
  for path in ['/usr/local/lib/node_modules','/usr/local/bin','/home/bell/.local']:
   _,trees[path]=archive(row,path);assert trees[path]==old[path],path
  result['allCliBinaryCursorSame']=True
 REPORT['architectures'][arch]=result;atomic(ROOT/'byte-results.json',REPORT);remove(row)

def runtime_check():
 row=create('amd64','runtime-amd64',True);output=command(['docker','start','-a','-i',row['id']],stdin=BASE/'runtime-artifact.mjs',cid=row['id']);info=inspect(row['id']);configured_ok(info,PLAN,row['name'])
 assert not info['State']['Running'] and info['State']['ExitCode']==0 and not info['State']['OOMKilled'];row.update(lastPid=row.get('pid'),lastStartTicks=row.get('startTicks'),pid=None,startTicks=None);save();REPORT['runtime']=[json.loads(x) for x in output.splitlines() if x.startswith('{')];assert any(x.get('passed') is True for x in REPORT['runtime']);atomic(ROOT/'runtime-results.json',REPORT['runtime']);remove(row)

def fetch_metadata_and_native():
 def get(url,headers=None):
  with urllib.request.urlopen(urllib.request.Request(url,headers=headers or {}),timeout=30) as r:return r.read(2*1024*1024)
 token=json.loads(get('https://ghcr.io/token?service=ghcr.io&scope=repository:kitepon/bellteam-server:pull'))['token']
 headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json'};url='https://ghcr.io/v2/kitepon/bellteam-server/'
 raw=get(url+'manifests/'+PLAN['image'],headers);assert 'sha256:'+hashlib.sha256(raw).hexdigest()==PLAN['image'];atomic(ROOT/'index.json',json.loads(raw))
 index=json.loads(raw);actual={m['platform']['architecture']:m['digest'] for m in index['manifests']};assert actual=={a:v['manifest_digest'] for a,v in REG['architectures'].items()}
 for arch,expected in REG['architectures'].items():
  raw=get(url+'manifests/'+expected['manifest_digest'],headers);assert 'sha256:'+hashlib.sha256(raw).hexdigest()==expected['manifest_digest'];manifest=json.loads(raw);assert manifest['config']['digest']==expected['config_digest'];atomic(ROOT/(arch+'-manifest.json'),manifest)
  raw=get(url+'blobs/'+expected['config_digest'],headers);assert 'sha256:'+hashlib.sha256(raw).hexdigest()==expected['config_digest'];config=json.loads(raw);assert config['config']['Labels']['org.opencontainers.image.revision']==PLAN['source'];atomic(ROOT/(arch+'-config.json'),config)
 raw=get('https://registry.npmjs.org/aiterm-mcp/-/aiterm-mcp-0.61.21.tgz');assert hashlib.sha256(raw).hexdigest()=='41bbf393d3a29c62f014e0282638c627beb1854efe48935116faad37e9dac7fc';(BASE/'official-aiterm.tgz').write_bytes(raw)
def main():
 global deadline,owns_state,DOCKER_ROOT
 if len(sys.argv)!=2 or sys.argv[1] not in ['amd64','arm64']:raise Held('one architecture argument required')
 arch=sys.argv[1]
 if os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('CI_RUNNER_ENVIRONMENT')!='github-hosted':raise Held('GitHub-hosted CI only')
 if platform.machine()!= {'amd64':'x86_64','arm64':'aarch64'}[arch]:raise Held('native CI architecture mismatch')
 runid=os.environ.get('GITHUB_RUN_ID','');assert runid.isdigit()
 PLAN['run']='ci-c5a20bd3-'+runid+'-'+arch;PLAN['fixturePrefix']='centi-ci-c5a20bd3-'+runid+'-'+arch;STATE['run']=REPORT['run']=PLAN['run']
 if STATE_PATH.exists():raise Held('one attempt only: output state exists')
 owns_state=True
 info=json.loads(subprocess.check_output(['docker','info','--format','{"root":{{json .DockerRootDir}},"cgroupVersion":{{json .CgroupVersion}},"architecture":{{json .Architecture}}}'],text=True,timeout=15));assert info['cgroupVersion']=='2';assert info['architecture'] in {'amd64':['x86_64','amd64'],'arm64':['aarch64','arm64']}[arch];DOCKER_ROOT=pathlib.Path(info['root']);STATE['ciMachine']={'architecture':platform.machine(),'docker':info,'runnerOS':os.environ.get('RUNNER_OS'),'runnerArch':os.environ.get('RUNNER_ARCH'),'imageOS':os.environ.get('ImageOS'),'imageVersion':os.environ.get('ImageVersion')};STATE['preflight']=resources(True);deadline=time.time()+PLAN['ci']['scriptSeconds'];STATE['overallDeadline']=datetime.datetime.fromtimestamp(deadline,datetime.timezone.utc).isoformat();save()
 fetch_metadata_and_native()
 phase('pull-'+arch,lambda:command(['docker','pull','--platform','linux/'+arch,'ghcr.io/kitepon/bellteam-server@'+REG['architectures'][arch]['manifest_digest']]))
 phase('bytes-'+arch,lambda:bytes_check(arch))
 if arch=='amd64':phase('runtime-amd64',runtime_check)
 phase('cleanup',lambda:None);assert all(x.get('removed') for x in STATE['containers']);REPORT.update(passed=True,source=PLAN['source'],completedAt=utc(),environment='GitHub-hosted disposable VM; not main-server');atomic(ROOT/'completed.json',REPORT)
def entry():
 global current,phase_deadline
 try:main()
 except Exception as e:
  if owns_state:STATE.update(phaseStatus='failed',failure=str(e));save();atomic(ROOT/'failed.json',{'at':utc(),'error':str(e),'noAutomaticRetry':True,'state':STATE})
  raise
 finally:
  if owns_state:
   current='cleanup';phase_deadline=time.time()+30
   for row in STATE['containers']:
    if row.get('removed'):continue
    try:
     value=inspect(row['id']);configured_ok(value,PLAN,row['name'])
     if value['State']['Running']:row['cleanup']='retained-running; disposable CI VM teardown only'
     else:remove(row)
    except Exception as error:row['cleanup']='unconfirmed: '+str(error)
   atomic(ROOT/'residual.json',{'containers':STATE['containers'],'unknownClients':[c for c in STATE['commands'] if c.get('completion')=='unknown-after-deadline']});save()
if __name__=='__main__':entry()
