import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

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
  const command = await recipe(), root = await mkdtemp(join(tmpdir(), 'manual-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const p of ['bin','scripts','src','runtime/backups/image-before-deploy.OLD123','.bellteam-compose.NEW123','.bellteam-compose.OLD123','backups','views']) await mkdir(root + '/' + p, { recursive: true, mode: 0o700 })
  await copyFile(new URL('../src/server-state-writers.mjs', import.meta.url), root + '/src/server-state-writers.mjs')
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
  if (failure==='existing-backup') await writeFile(root+'/backups/legacy','keep-original-partial-backup')
  if (failure==='mode') await chmod(saved+'/recovery.json',0o644)
  await writeFile(root+'/scripts/check-deploy-quiet.sh','#!/bin/sh\ndocker fixture-quiet\n')
  const env = {...process.env,PATH:root+'/bin:'+process.env.PATH,TEST_ROOT:root,TEST_FAIL:failure,TEST_EVENTS:root+'/events',saved,quiet_except:'bot-fixture',TMPDIR:root}
  const programs = {
    docker: String.raw`const fs=require('node:fs'),cp=require('node:child_process'),a=process.argv.slice(2),e=process.env,r=e.TEST_ROOT;
const event=(kind,extra={})=>fs.appendFileSync(e.TEST_EVENTS,JSON.stringify({kind,args:a,compose:e.COMPOSE_FILE,project:e.COMPOSE_PROJECT_NAME,...extra})+'\n');
const output=x=>console.log(typeof x==='string'?x:JSON.stringify(x));
const current=()=>JSON.parse(fs.readFileSync(r+'/current.json'));
event('call');
if(a[0]==='image'){output(a.at(-1));process.exit(0)}
if(a[0]==='container'){
 const c=current(),f=a[a.indexOf('--format')+1];
 if(f==='{{json .}}')output(c);else if(f==='{{.Image}}')output(e.TEST_FAIL==='restarted-image'?'sha256:'+'e'.repeat(64):c.Image);
 else output(c.Id+' '+c.Image+' '+(e.TEST_FAIL==='stopped'?true:c.State.Running)+' '+c.State.Restarting+' '+c.State.StartedAt);
 process.exit(0)
}
if(a[0]==='fixture-quiet'){event('quiet');process.exit(e.TEST_FAIL==='quiet'?52:0)}
if(a[0]==='fixture-check'){event('check',{maintenance:JSON.parse(fs.readFileSync(a[1]))});process.exit(e.TEST_FAIL==='check'?54:0)}
if(a[0]==='run'&&a.includes('/bin/cat')){
 event('extract');process.stdout.write('#!/bin/sh\ndocker fixture-check "$(dirname "$0")/../compose.state-maintenance.json"\n');process.exit(0)
}
if(a[0]==='exec'){
 event('health');output(e.TEST_FAIL==='health'?'{"status":"not-ok","reason":"ok"}':e.TEST_FAIL==='json'?'bad-json':'{"status":"ok"}');process.exit(e.TEST_FAIL==='http'?7:0)
}
if(a[0]==='compose'){
 if(a.includes('--hash')){output('bellteam '+'f'.repeat(64));process.exit(0)}
 if(a.includes('stop')){event('stop');if(e.TEST_FAIL==='stop')process.exit(53);const c=current();c.State.Running=false;c.State.Restarting=false;fs.writeFileSync(r+'/current.json',JSON.stringify(c));process.exit(0)}
 if(a.includes('up')){const file=a[a.indexOf('-f')+1],model=JSON.parse(fs.readFileSync(file));event('up',{file,model});if(e.TEST_FAIL==='up')process.exit(57);const c=current();c.Image=model.services.bellteam.image;c.State.Running=true;fs.writeFileSync(r+'/current.json',JSON.stringify(c));process.exit(0)}
 if(a.includes('to-legacy')){event('inverse',{file:a[a.indexOf('-f')+1]});process.exit(e.TEST_FAIL==='inverse'?55:0)}
 if(a.includes('--entrypoint')){
  event('backup-call',{file:a[a.indexOf('-f')+1]});const code=a.at(-1),p=cp.spawnSync(process.execPath,['--import',r+'/hooks.mjs','--input-type=module','-e',code],{env:e,encoding:'utf8'});process.stdout.write(p.stdout);process.stderr.write(p.stderr);process.exit(p.status)
 }
}
throw Error('unexpected Docker call');`,
  }
  for (const [name, code] of Object.entries(programs)) { await writeFile(root+'/bin/'+name,'#!'+process.execPath+'\n'+code); await chmod(root+'/bin/'+name,0o700) }
  await writeFile(root+'/backup-spy.mjs',String.raw`import fs from 'node:fs';
export async function backupServerState({root,backupRoot,direction}){
 const view=root==='/srv/bellteam-legacy'?'legacy':'server',e=process.env;
 fs.appendFileSync(e.TEST_EVENTS,JSON.stringify({kind:'backup-'+view,root,backupRoot,direction})+'\n');
 if(e.TEST_FAIL==='backup-'+view)throw Object.assign(new Error('private data never print'),{code:'EIO'});
 fs.writeFileSync(e.TEST_ROOT+'/backups/'+view,fs.readFileSync(e.TEST_ROOT+'/views/'+view),{flag:'wx'});
}`)
  await writeFile(root+'/hooks.mjs',String.raw`import {registerHooks} from 'node:module';
for(const key of ['getuid','geteuid','getgid','getegid'])Object.defineProperty(process,key,{value:()=>0});
registerHooks({resolve(s,c,next){if(s==='/app/src/server-state-backup.mjs')return{url:new URL('./backup-spy.mjs',import.meta.url).href,shortCircuit:true};return next(s,c)},load(url,c,next){if(url==='node:fs/promises')return{format:'module',shortCircuit:true,source:'export async function lstat(){return{isDirectory:()=>true,uid:0,gid:0,mode:448,dev:1,ino:1}};export async function mkdir(){}'};return next(url,c)}});`)
  return {root,saved,original,archive,normal,previous,maintenance,env,command,
    run:()=>exec('sh',['-c',command],{cwd:root,env,timeout:10000}),
    events:async()=>{try{return(await readFile(env.TEST_EVENTS,'utf8')).trim().split('\n').map(JSON.parse)}catch(e){if(e.code==='ENOENT')return[];throw e}}}
}

test('manual recovery: exact legacy generation orders quiet-stop-check-inverse-old-normal-health',async t=>{
 const f=await fixture(t);const out=await f.run();const events=await f.events()
 assert.deepEqual(events.filter(e=>['quiet','stop','check','inverse','up','health'].includes(e.kind)).map(e=>e.kind),['quiet','stop','check','inverse','up','health'])
 assert.equal(events.find(e=>e.kind==='up').file,f.original)
 assert.equal(events.find(e=>e.kind==='inverse').file,f.saved+'/compose.state-maintenance.json')
 assert.deepEqual(events.find(e=>e.kind==='check').maintenance,JSON.parse(await readFile(f.saved+'/compose.state-maintenance.json')))
 assert.equal(events.find(e=>e.kind==='up').model.services.bellteam.image,oldImage)
 assert.doesNotMatch(out.stdout+out.stderr,/synthetic-private-secret/)
 assert.ok(!events.some(e=>e.args?.includes('build')||e.args?.includes('pull')))
 if(process.env.TEST_MANUAL_RECEIPT_DIR){const p=resolve(process.env.TEST_MANUAL_RECEIPT_DIR);await mkdir(p,{recursive:true});await writeFile(p+'/legacy-events.json',JSON.stringify(events,null,2));await writeFile(p+'/manual.sh',f.command)}
})
test('manual recovery: stopped original private layout backs up both latest views without inverse',async t=>{
 const f=await fixture(t,'server','',true);await f.run();const events=await f.events()
 assert.deepEqual(events.filter(e=>['quiet','stop','check','backup-legacy','backup-server','inverse','up','health'].includes(e.kind)).map(e=>e.kind),['stop','check','backup-legacy','backup-server','up','health'])
 for(const view of ['legacy','server'])assert.equal(await readFile(f.root+'/backups/'+view,'utf8'),await readFile(f.root+'/views/'+view,'utf8'))
 const backup=events.find(e=>e.kind==='backup-call');assert.equal(backup.file,f.saved+'/compose.state-maintenance.json')
 assert.deepEqual(backup.args.slice(backup.args.indexOf('state-maintenance')+1,backup.args.indexOf('state-maintenance')+4),['-i','PATH=/usr/local/bin:/usr/bin:/bin','/usr/local/bin/node'])
 if(process.env.TEST_MANUAL_RECEIPT_DIR)await writeFile(resolve(process.env.TEST_MANUAL_RECEIPT_DIR)+'/server-events.json',JSON.stringify(events,null,2))
})
test('manual recovery: quiet stop checker inverse or backup failure never starts the original',async t=>{
 for(const failure of ['quiet','stop','stopped','check','inverse','backup-legacy','backup-server','existing-backup']){
  const f=await fixture(t,failure.startsWith('backup')||failure==='existing-backup'?'server':'legacy',failure)
  await assert.rejects(f.run());assert.ok(!(await f.events()).some(e=>e.kind==='up'||e.kind==='health'))
  assert.ok((await readdir(f.saved)).includes('normal.json'));assert.ok((await readdir(f.archive)).includes('container-image.txt'))
  if(failure==='existing-backup')assert.equal(await readFile(f.root+'/backups/legacy','utf8'),'keep-original-partial-backup')
  if(failure==='backup-server')assert.equal(await readFile(f.root+'/backups/legacy','utf8'),'latest-legacy-not-old-archive')
 }
})
test('manual recovery: unknown current hash mode or layout refuses stop and failed restart remains unconfirmed',async t=>{
 for(const failure of ['identity','service','hash','mode','layout']){
  const f=await fixture(t,'legacy',failure);await assert.rejects(f.run(),e=>e.code===1&&e.stderr.includes('BELLTEAM_RECOVERY_SELECTION_UNAVAILABLE'))
  assert.ok(!(await f.events()).some(e=>['quiet','stop','check','inverse','up'].includes(e.kind)))
 }
 for(const failure of ['up','restarted-image','health','json','http']){
  const f=await fixture(t,'legacy',failure);await assert.rejects(f.run());const events=await f.events()
  assert.equal(events.filter(e=>e.kind==='up').length,1)
  assert.ok((await readdir(f.saved)).includes('recovery.json'))
 }
})
