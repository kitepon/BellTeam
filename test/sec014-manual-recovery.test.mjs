import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {copyInternalAdapter} from './fixtures/sec014-adapter.mjs'

const exec = promisify(execFile), oldImage = 'sha256:' + 'd'.repeat(64), migrationImage = 'sha256:' + 'a'.repeat(64)
const oldCID = 'c'.repeat(64), targetCID = 'b'.repeat(64)
const stateNames = ['state','rooms','owner','logs','bellteam-settings','apns']
const stateTargets = ['state','rooms','owner','logs','shared/tools/bellteam-settings','shared/tools/apns'].map(p => '/srv/bellteam/' + p)
async function recipe() {
  const source = await readFile(process.env.README_UNDER_TEST || new URL('../distribution/internal/README.md', import.meta.url), 'utf8')
  const begin = source.indexOf('<!-- sec014-manual-recovery -->\n```sh\n')
  assert.ok(begin >= 0, 'the selected-generation manual procedure exists')
  const offset = begin + '<!-- sec014-manual-recovery -->\n```sh\n'.length
  return source.slice(offset, source.indexOf('\n```', offset))
}
async function fixture(t, layout = 'legacy', failure = '', originalCurrent = false) {
  const command = 'sh scripts/deploy-image.sh --recover \"$saved\" \"$quiet_except\"', root = await mkdtemp(join(tmpdir(), 'manual-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const p of ['bin','scripts','src','runtime/backups/image-before-deploy.OLD123','.bellteam-compose.NEW123','.bellteam-compose.OLD123','backups','views']) await mkdir(root + '/' + p, { recursive: true, mode: 0o700 })
  await copyFile(new URL('../src/server-state-writers.mjs', import.meta.url), root + '/src/server-state-writers.mjs')
  await copyInternalAdapter(new URL('../scripts/deploy-image.sh',import.meta.url),root+'/scripts/deploy-image.sh')
  const saved = root + '/.bellteam-compose.NEW123', original = root + '/.bellteam-compose.OLD123/previous-normal.json'
  const archive = root + '/runtime/backups/image-before-deploy.OLD123'
  const bind = (source, target) => ({ type: 'bind', source, target })
  const mounts = [bind(root + '/data','/srv/bellteam'),bind(root + '/home','/home/bell'),{type:'volume',source:'cursor-cli',target:'/home/bell/.local'}]
  const state = stateNames.map((p,i) => bind(root + '/private$P/' + p,stateTargets[i]))
  const normal = { name:'bellteam', services:{bellteam:{image:migrationImage,environment:{SECRET:'synthetic-private-secret'},volumes:[...mounts,...state]}},volumes:{'cursor-cli':{name:'bellteam_cursor-cli'}} }
  const previous = {...normal,services:{bellteam:{...normal.services.bellteam,image:oldImage,volumes:[...mounts,...(layout==='server'?state:[])]}}}
  const maintenance = {services:{'state-maintenance':{image:migrationImage,user:'0:0',entrypoint:['/usr/bin/env','-i','PATH=/usr/local/bin:/usr/bin:/bin','/usr/local/bin/node','/app/src/server-state-transfer.mjs'],environment:{},volumes:[bind(root+'/data','/srv/bellteam-legacy'),bind(root+'/data','/srv/bellteam'),...state,bind(root+'/backups','/srv/bellteam-maintenance-backups')]}}}
  const record = {previousCompose:original,previousImageArchive:archive,stateLayout:failure==='layout'?'server':layout}
  const runtime = {Id:oldCID,Image:oldImage,State:{StartedAt:'2026-10-27T16:03:53Z'}}
  const current = {Id:originalCurrent?oldCID:targetCID,Image:originalCurrent?oldImage:migrationImage,
    State:{StartedAt:originalCurrent?runtime.State.StartedAt:'2026-10-27T22:00:00Z',Running:!originalCurrent,Restarting:false},
    Config:{Labels:{'com.docker.compose.project':'bellteam','com.docker.compose.service':'bellteam','com.docker.compose.project.config_files':saved+'/normal.json','com.docker.compose.config-hash':'f'.repeat(64)}}}
  if (failure==='identity') current.Image = 'sha256:'+'e'.repeat(64)
  if (failure==='service') current.Config.Labels['com.docker.compose.service']='other'
  if (failure==='hash') current.Config.Labels['com.docker.compose.config-hash']='wrong'
  const write = (p, data, compose = false) => writeFile(p,JSON.stringify(data,(_k,v)=>compose&&typeof v==='string'?v.replaceAll('$',()=> '$$'):v),{mode:0o600})
  await write(saved+'/normal.json',normal,true); await write(original,previous,true)
  await write(saved+'/compose.state-maintenance.json',maintenance,true); await write(saved+'/recovery.json',record)
  await write(root+'/.bellteam-compose.OLD123/previous-runtime.json',runtime)
  await write(root+'/current.json',current)
  await writeFile(archive+'/container-image.txt',oldCID+' '+oldImage+'\n',{mode:0o600})
  await writeFile(archive+'/container-started-at.txt',runtime.State.StartedAt+'\n',{mode:0o600})
  await writeFile(archive+'/previous-compose.path',original+'\n',{mode:0o600})
  await writeFile(root+'/views/legacy','latest-legacy-not-old-archive'); await writeFile(root+'/views/server','latest-server-after-forward')
  if (failure==='mode') await chmod(saved+'/recovery.json',0o644)
  await writeFile(root+'/scripts/check-deploy-quiet.sh','#!/bin/sh\ndocker fixture-quiet\n')
  const env = {...process.env,PATH:root+'/bin:'+process.env.PATH,TEST_ROOT:root,TEST_FAIL:failure,TEST_EVENTS:root+'/events',saved,quiet_except:'bot-fixture',TMPDIR:root}
  const programs = {
    docker: String.raw`const fs=require('node:fs'),a=process.argv.slice(2),e=process.env,r=e.TEST_ROOT;
const event=(kind,extra={})=>fs.appendFileSync(e.TEST_EVENTS,JSON.stringify({kind,args:a,...extra})+'\n');
const output=x=>console.log(typeof x==='string'?x:JSON.stringify(x));
const current=()=>JSON.parse(fs.readFileSync(r+'/current.json'));
if(a[0]==='stop'){
 event('stop');if(e.TEST_FAIL==='stop')process.exit(53);const c=current();c.State.Running=false;c.State.Restarting=false;fs.writeFileSync(r+'/current.json',JSON.stringify(c));process.exit(0)
}
if(a[0]==='image'){output(a.at(-1));process.exit(0)}
if(a[0]==='container'){
 const c=current(),f=a[a.indexOf('--format')+1];
 if(f==='{{json .}}')output(c);
 else output(c.Id+' '+c.Image+' '+(e.TEST_FAIL==='stopped'?true:c.State.Running)+' '+c.State.Restarting+' '+c.State.StartedAt);
 process.exit(0)
}
if(a[0]==='fixture-quiet'){event('quiet');process.exit(e.TEST_FAIL==='quiet'?52:0)}
if(a[0]==='fixture-recover'){event('actor',{saved:a[1],cid:a[2]});process.exit(e.TEST_FAIL==='actor'?58:0)}
if(a[0]==='compose'&&a.includes('--hash')){output('bellteam '+'f'.repeat(64));process.exit(0)}
throw Error('unexpected Docker call');`,
  }
  for (const [name, code] of Object.entries(programs)) { await writeFile(root+'/bin/'+name,'#!'+process.execPath+'\n'+code); await chmod(root+'/bin/'+name,0o700) }
  return {root,saved,original,archive,normal,previous,maintenance,env,command,
    run:()=>exec('sh',['-c',command],{cwd:root,env,timeout:10000}),
    events:async()=>{try{return(await readFile(env.TEST_EVENTS,'utf8')).trim().split('\n').map(JSON.parse)}catch(e){if(e.code==='ENOENT')return[];throw e}}}
}

test('manual procedure invokes only the canonical root recovery adapter',async()=>{
 const command=await recipe()
 assert.match(command,/sudo -n \/usr\/bin\/env -i PATH=\/usr\/local\/bin:\/usr\/bin:\/bin HOME=\/root/u)
 assert.match(command,/scripts\/deploy-image\.sh --recover "\$saved" "\$quiet_except"/u)
 assert.doesNotMatch(command,/docker|to-legacy| up | start /u)
})

test('manual recovery orders quiet, exact stop and one actor handoff',async t=>{
 for(const layout of ['legacy','server']){
  const f=await fixture(t,layout);const out=await f.run();const events=await f.events()
  assert.deepEqual(events.map(e=>e.kind),['quiet','stop','actor'])
  assert.deepEqual(events.find(e=>e.kind==='stop').args,['stop',targetCID])
  assert.equal(events.find(e=>e.kind==='actor').saved,f.saved+'/normal.json')
  assert.equal(events.find(e=>e.kind==='actor').cid,targetCID)
  assert.doesNotMatch(out.stdout+out.stderr,/synthetic-private-secret/)
  assert.ok((await readdir(f.saved)).includes('recovery.json'))
 }
})

test('already stopped original hands its exact CID to the actor without another stop',async t=>{
 const f=await fixture(t,'server','',true);await f.run();const events=await f.events()
 assert.deepEqual(events.map(e=>e.kind),['actor']);assert.equal(events[0].cid,oldCID)
})

test('quiet or failed stop never reaches the actor; actor failure is not retried',async t=>{
 for(const failure of ['quiet','stop','stopped','actor']){
  const f=await fixture(t,'legacy',failure);await assert.rejects(f.run());const events=await f.events()
  assert.equal(events.filter(e=>e.kind==='actor').length,failure==='actor'?1:0)
  assert.ok((await readdir(f.saved)).includes('normal.json'))
  assert.ok((await readdir(f.archive)).includes('container-image.txt'))
  assert.equal(await readFile(f.root+'/views/server','utf8'),'latest-server-after-forward')
 }
})

test('unknown current hash, mode or layout refuses quiet and stop',async t=>{
 for(const failure of ['identity','service','hash','mode','layout']){
  const f=await fixture(t,'legacy',failure)
  await assert.rejects(f.run(),e=>e.code===1&&e.stderr.includes('BELLTEAM_RECOVERY_SELECTION_UNAVAILABLE'))
  assert.deepEqual(await f.events(),[])
 }
})
