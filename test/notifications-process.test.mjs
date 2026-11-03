import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createNotificationsProcess } from '../src/notifications-process.mjs'
const fixture = new URL('./fixtures/notifications-runtime-child.mjs',import.meta.url).pathname
const ids={a:'a'.repeat(64),b:'b'.repeat(64),bad:'c'.repeat(64),hang:'d'.repeat(64)}
async function setup(t,{mode='',prepare=async()=>{},report=async()=>{}}={}) {
  const root=await mkdtemp(join(tmpdir(),'notifications-controller-'));await mkdir(join(root,'state'))
  const realOpen=fsPromises.open
  t.mock.method(fsPromises,'open',async(path,...args)=>path==='/app/distribution.json'
    ? {stat:async()=>({isFile:()=>true,uid:0,nlink:1,mode:0o644,size:135}),readFile:async()=>JSON.stringify({schema:'bellteam.server.distribution.v1',sourceCommit:'e'.repeat(40)}),close:async()=>{}}
    :realOpen(path,...args))
  const spawn=childProcess.spawn, children=[]
  t.mock.method(childProcess,'spawn',(command,args,options)=>{
    assert.equal(command,'/usr/local/libexec/bellteam-notifications-start')
    assert.deepEqual(options.env,{})
    assert.deepEqual(options.stdio,['ignore','inherit','inherit','ipc'])
    assert.equal(args.length,1)
    const child=spawn(process.execPath,[fixture,args[0],args[0]===ids.bad?'bad-initialize':args[0]===ids.hang?'hang-initialize':mode,root],options)
    children.push(child);return child
  });syncBuiltinESMExports()
  const states=[]
  const controller=createNotificationsProcess({root,configuration:()=>({enabled:false,relayUrl:''}),onDiagnostic:report,onState:s=>states.push(s),
    prepareRelease:async(id,options)=>{await prepare(id,options);return {versionId:id,appRoot:`/run/bellteam-maintenance/notifications/releases/${id}/payload`,protocolVersion:1,stateSchema:1}}})
  t.after(async()=>{await controller.close();t.mock.restoreAll();syncBuiltinESMExports();await rm(root,{recursive:true,force:true})})
  return {controller,children,root,states}
}
test('A to B to A retains current state and current/previous adoption references',async t=>{
  const {controller,root,children}=await setup(t)
  await controller.start()
  await controller.request('register',{token:'persist'})
  await controller.replace(ids.a);await controller.replace(ids.b);await controller.replace(ids.a)
  assert.deepEqual(JSON.parse(await readFile(join(root,'state/push-devices.json'),'utf8')),[{token:'persist'}])
  assert.equal(controller.snapshot().currentVersionId,ids.a)
  const record=JSON.parse(await readFile(join(root,'state/notifications-release.json'),'utf8'))
  assert.equal(record.previousVersionId,ids.b)
  assert.equal(children.filter(c=>c.exitCode===null&&c.signalCode===null).length,1)
  const first=controller.close();assert.equal(controller.close(),first);await first
  assert.equal(controller.snapshot().phase,'closed')
})
test('new initialization failure reaps child and rolls back without rewriting business state',async t=>{
  const {controller,children,root}=await setup(t)
  await controller.start();await controller.replace(ids.a)
  await controller.request('register',{token:'kept'})
  await assert.rejects(controller.replace(ids.bad),/NOTIFICATIONS_REPLACE_ROLLED_BACK/)
  assert.equal(controller.snapshot().currentVersionId,ids.a)
  assert.equal(controller.snapshot().available,true)
  assert.equal(children.filter(c=>c.exitCode===null&&c.signalCode===null).length,1)
  assert.equal(JSON.parse(await readFile(join(root,'state/push-devices.json'),'utf8'))[0].token,'kept')
})
test('adoption save failure restores builtin without requiring a writable adoption path',async t=>{
  const {controller,root}=await setup(t)
  await controller.start()
  await mkdir(join(root,'state/notifications-release.json'))
  await assert.rejects(controller.replace(ids.a),/NOTIFICATIONS_REPLACE_ROLLED_BACK/)
  assert.equal(controller.snapshot().currentVersionId,null)
  assert.equal(controller.snapshot().available,true)
})
test('configure blocks reservation, version validation and close abort prepare without new child',async t=>{
  let release, entered
  const entering=new Promise(r=>{entered=r})
  const {controller,children}=await setup(t,{prepare:async()=>{entered();await new Promise(r=>{release=r})}})
  await controller.start()
  const configuring=controller.request('configure',{enabled:false,relayUrl:'',delay:100})
  assert.throws(()=>controller.reserve(ids.a),{status:409})
  await configuring
  assert.throws(()=>controller.reserve('../path'),{status:400})
  const update=controller.replace(ids.a)
  await entering
  const rejected=assert.rejects(update)
  const closing=controller.close();release();await rejected;await closing
  assert.equal(children.length,1)
})
test('quiesce deadline resumes the same old child and never starts a new writer',async t=>{
  const {controller,children}=await setup(t,{mode:'hang-quiesce'})
  await controller.start()
  t.mock.timers.enable({apis:['setTimeout']})
  const update=controller.replace(ids.a),rejected=assert.rejects(update,/NOTIFICATIONS_QUIESCE_FAILED/)
  while(controller.snapshot().phase!=='quiescing') await new Promise(resolve=>setImmediate(resolve))
  // Let the quiesce request install its own 60-second deadline, then advance only the parent clock.
  await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(60001)
  await rejected
  assert.equal(controller.snapshot().available,true);assert.equal(children.length,1)
  t.mock.timers.reset()
  children[0].kill('SIGKILL')
})

test('startup validates current and previous; malformed adoption cannot start builtin',async t=>{
  const prepared=[]
  const {controller,root}=await setup(t,{prepare:async id=>prepared.push(id)})
  await writeFile(join(root,'state/notifications-release.json'),JSON.stringify({schema:'bellteam.notifications.adoption.v1',currentVersionId:ids.a,previousVersionId:ids.b}),{mode:0o600})
  await controller.start();assert.deepEqual(prepared,[ids.a,ids.b])
  assert.equal(controller.snapshot().currentVersionId,ids.a)
})
test('corrupt adoption rejects before any child is created',async t=>{
 const {controller,root,children}=await setup(t)
 await writeFile(join(root,'state/notifications-release.json'),'not-json',{mode:0o600})
 await assert.rejects(controller.start(),{code:'NOTIFICATIONS_ADOPTION_INVALID'})
 assert.equal(children.length,0)
})
test('quiesced exit has a five-second deadline and reaps the same child',async t=>{
 const {controller,children}=await setup(t,{mode:'hang-exit'})
 await controller.start();t.mock.timers.enable({apis:['setTimeout']})
 const closed=controller.close()
 for(let i=0;i<20;i++) await new Promise(resolve=>setImmediate(resolve))
 t.mock.timers.tick(5001);await closed;t.mock.timers.reset()
 assert.equal(children[0].signalCode,'SIGKILL')
})
test('45-second new initialization timeout reaps new child and returns to old version',async t=>{
 const {controller,children}=await setup(t)
 await controller.start();t.mock.timers.enable({apis:['setTimeout']})
 const update=controller.replace(ids.hang),rejected=assert.rejects(update,/NOTIFICATIONS_REPLACE_ROLLED_BACK/)
 while(children.length<2) await new Promise(resolve=>setImmediate(resolve))
 t.mock.timers.tick(45001);await rejected;t.mock.timers.reset()
 assert.equal(controller.snapshot().available,true);assert.equal(controller.snapshot().currentVersionId,null)
 assert.equal(children[1].signalCode,'SIGKILL')
})

test('explicit builtin target returns to image-owned source and persists its previous signed version',async t=>{
 const {controller,root}=await setup(t)
 await controller.start();await controller.replace(ids.a);await controller.replace('builtin')
 const state=controller.snapshot();assert.equal(state.currentTarget,'builtin');assert.equal(state.currentVersionId,null)
 assert.match(state.builtinSourceCommit,/^[a-f0-9]{40}$/)
 const record=JSON.parse(await readFile(join(root,'state/notifications-release.json'),'utf8'))
 assert.equal(record.currentVersionId,null);assert.equal(record.previousVersionId,ids.a)
 const reservation=controller.reserve('builtin');reservation.cancel()
 assert.equal(controller.snapshot().update.status,'not_started')
})

test('adopted builtin with a previous release is read back as builtin on restart',async t=>{
 const prepared=[]
 const {controller,root}=await setup(t,{prepare:async id=>prepared.push(id)})
 await writeFile(join(root,'state/notifications-release.json'),JSON.stringify({schema:'bellteam.notifications.adoption.v1',currentVersionId:null,previousVersionId:ids.a}),{mode:0o600})
 await controller.start();assert.deepEqual(prepared,[ids.a]);assert.equal(controller.snapshot().currentTarget,'builtin')
})
