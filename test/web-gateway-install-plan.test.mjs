import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { notificationsInstallPlan } from '../src/notifications-install-plan.mjs'
import { membersInstallPlan } from '../src/members-install-plan.mjs'
import { webGatewayInstallPlan } from '../src/web-gateway-install-plan.mjs'
const execute = promisify(execFile)
const image = 'sha256:' + 'a'.repeat(64), cid = 'b'.repeat(64)
const parts = ['state','rooms','owner','logs','shared/tools/bellteam-settings','shared/tools/apns']
function fixture() {
  const volumes = [
    {type:'bind',source:'/installation/runtime/data',target:'/srv/bellteam'},
    {type:'bind',source:'/installation/runtime/home',target:'/home/bell'},
    {type:'volume',source:'cursor',target:'/home/bell/.local'},
    ...parts.map(part=>({type:'volume',source:'state',target:'/srv/bellteam/'+part,volume:{nocopy:true,subpath:part.split('/').at(-1)}})),
    {type:'volume',source:'state',target:'/run/bellteam-maintenance',read_only:true,volume:{nocopy:true}},
  ]
  const normal={name:'fixture',services:{bellteam:{image,volumes,environment:{SECRET:'never-copy'}}},volumes:{cursor:{name:'fixture_cursor'},state:{name:'fixture_state',external:true}}}
  const current={id:cid,image,running:true,restarting:false,readOnly:true,project:'fixture',mounts:[
    {Type:'bind',Source:'/installation/runtime/data',Destination:'/srv/bellteam',RW:true},
    {Type:'bind',Source:'/installation/runtime/home',Destination:'/home/bell',RW:true},
    {Type:'volume',Name:'fixture_state',Source:'/docker/private',Destination:'/run/bellteam-maintenance',RW:false},
    ...parts.map(part=>({Type:'volume',Name:'fixture_state',Source:'/docker/private',Destination:'/srv/bellteam/'+part,RW:true})),
  ],specMounts:[
    {Type:'volume',Source:'fixture_state',Target:'/run/bellteam-maintenance',ReadOnly:true,VolumeOptions:{NoCopy:true}},
    ...parts.map(part=>({Type:'volume',Source:'fixture_state',Target:'/srv/bellteam/'+part,ReadOnly:false,VolumeOptions:{NoCopy:true,Subpath:part.split('/').at(-1)}})),
  ]}
  return {normal,current}
}

test('online model uses only fixed code, read-only incoming and the same private volume',()=>{
  const {normal,current}=fixture(),model=webGatewayInstallPlan(normal,current),s=model.services['web-gateway-install']
  assert.equal(s.image,image);assert.equal(s.user,'0:0');assert.equal(s.network_mode,'none');assert.equal(s.read_only,true)
  assert.deepEqual(s.entrypoint,['/usr/bin/env','-i','PATH=/usr/local/bin:/usr/bin:/bin','/usr/bin/python3','-I','/app/scripts/install-web-gateway-release.py'])
  assert.equal(s.volumes.length,2);assert.equal(s.volumes[0].read_only,true);assert.equal(s.volumes[0].bind.create_host_path,false)
  assert.equal(s.volumes[0].source,'/installation/runtime/web-gateway-incoming')
  assert.deepEqual(model.volumes,{'server-state':{external:true,name:'fixture_state'}})
  assert.doesNotMatch(JSON.stringify(model),/SECRET|never-copy|docker.sock|\/home\/bell|flock -x/)
})

test('foreign CID/image/project/mount or a mutable normal root cannot select a helper',()=>{
  for(const change of [x=>x.current.id='bad',x=>x.current.image='sha256:'+'f'.repeat(64),x=>x.current.project='foreign',
    x=>x.current.running=false,x=>x.current.restarting=true,x=>x.current.readOnly=false,
    x=>x.current.mounts[2].Name='foreign',x=>x.current.mounts[2].RW=true,
    x=>x.current.mounts[3].Source='/other/state',x=>x.current.specMounts[1].VolumeOptions.Subpath='rooms',x=>x.current.specMounts[0].ReadOnly=false,x=>x.normal.services.bellteam.volumes[0].source='/other/data']){
    const value=fixture();change(value);assert.throws(()=>webGatewayInstallPlan(value.normal,value.current))
  }
})

test('installer mode preserves the running server and emits only fixed placement actions',async t=>{
  const root=await mkdtemp(join(tmpdir(),'gateway-installer-fixture-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const bin=join(root,'bin'),saved=join(root,'.bellteam-compose.fixture');await mkdir(bin);await mkdir(saved)
  const {normal,current}=fixture();await writeFile(join(saved,'normal.json'),JSON.stringify(normal))
  await writeFile(join(root,'current.json'),JSON.stringify(current));const log=join(root,'commands.jsonl')
  const plan=new URL('../src/web-gateway-install-plan.mjs',import.meta.url).pathname
  await writeFile(join(bin,'docker'),`#!/usr/bin/env python3
import json,os,sys,subprocess
from pathlib import Path
a=sys.argv[1:]
with open(os.environ['FIXTURE_LOG'],'a') as f:f.write(json.dumps(a)+'\\n')
if a[0]=='compose' and 'ps' in a: print('${cid}')
elif a[:2]==['container','inspect']:
 if a[a.index('--format')+1]=='{{.Image}}':print('${image}')
 else:print(Path(os.environ['FIXTURE_CURRENT']).read_text())
elif a[0]=='compose' and 'config' in a: print(Path(os.environ['FIXTURE_NORMAL']).read_text())
elif a[0]=='run':
 p=subprocess.run([os.environ['FIXTURE_NODE'],os.environ['FIXTURE_PLAN']],input=sys.stdin.buffer.read());sys.exit(p.returncode)
elif a[0]=='compose' and 'run' in a:
 model=json.loads(Path(a[a.index('-f')+1]).read_text());assert model['services'][os.environ['FIXTURE_COMPONENT']+'-install']['entrypoint'][-1]=='/app/scripts/install-'+os.environ['FIXTURE_COMPONENT']+'-release.py'
 assert a[-3:]==['${'c'.repeat(64)}','${'d'.repeat(40)}','${'e'.repeat(40)}']
 print('{"fixturePlacementOnly":true}')
else:sys.exit(91)
`,{mode:0o755})
  // The dedicated helper invocation is observed; no root process or signature success is simulated.
  await writeFile(join(root,'install.sh'),await readFile(new URL('../distribution/server/install.sh',import.meta.url)))
  const script=join(root,'install.sh')
  const env={...process.env,PATH:bin+':'+process.env.PATH,FIXTURE_LOG:log,FIXTURE_CURRENT:join(root,'current.json'),FIXTURE_NORMAL:join(saved,'normal.json'),FIXTURE_NODE:process.execPath,FIXTURE_PLAN:plan,FIXTURE_COMPONENT:'web-gateway'}
  await execute('sh',[script,'--install-web-gateway',saved,'c'.repeat(64),'d'.repeat(40),'e'.repeat(40)],{cwd:root,env})
  await execute('sh',[script,'--install-notifications',saved,'c'.repeat(64),'d'.repeat(40),'e'.repeat(40)],{cwd:root,env:{...env,FIXTURE_COMPONENT:'notifications',FIXTURE_PLAN:new URL('../src/notifications-install-plan.mjs',import.meta.url).pathname}})
  await execute('sh',[script,'--install-members',saved,'c'.repeat(64),'d'.repeat(40),'e'.repeat(40)],{cwd:root,env:{...env,FIXTURE_COMPONENT:'members',FIXTURE_PLAN:new URL('../src/members-install-plan.mjs',import.meta.url).pathname}})
  const commands=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse)
  assert.ok(commands.some(a=>a[0]==='compose'&&a.includes('web-gateway-install')))
  assert.ok(commands.some(a=>a[0]==='compose'&&a.includes('notifications-install')))
  assert.ok(commands.some(a=>a[0]==='compose'&&a.includes('members-install')))
  for(const a of commands)assert.ok(!a.some(v=>['stop','restart','up','update','rm','pull','exec'].includes(v)),JSON.stringify(a))
  assert.ok(commands.some(a=>a[0]==='run'&&a.includes('--pull')&&a.includes('never')))
  const inspection=commands.filter(a=>a[0]==='container').map(a=>a[a.indexOf('--format')+1]).join('\n')
  assert.doesNotMatch(inspection,/Config.Env/)
})

test('members install selects only its fixed helper and rejects a writable private mount',()=>{
 const {normal,current}=fixture(),model=membersInstallPlan(normal,current),s=model.services['members-install']
 assert.equal(s.entrypoint.at(-1),'/app/scripts/install-members-release.py')
 assert.equal(s.volumes[0].source,'/installation/runtime/members-incoming')
 assert.equal(s.volumes[0].target,'/srv/bellteam-members-incoming')
 assert.equal(s.volumes[0].read_only,true)
 current.mounts[2].RW=true;assert.throws(()=>membersInstallPlan(normal,current))
})

test('notification install reuses exact mount checks but selects only its fixed helper and incoming',()=>{
 const {normal,current}=fixture(),model=notificationsInstallPlan(normal,current),s=model.services['notifications-install']
 assert.equal(s.entrypoint.at(-1),'/app/scripts/install-notifications-release.py')
 assert.equal(s.volumes[0].source,'/installation/runtime/notifications-incoming')
 assert.equal(s.volumes[0].target,'/srv/bellteam-notifications-incoming')
 assert.equal(s.volumes[0].read_only,true)
 current.mounts[2].RW=true;assert.throws(()=>notificationsInstallPlan(normal,current))
})
