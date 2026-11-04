import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtemp,mkdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {createModuleProcess} from '../src/module-process.mjs'
import {moduleDrainDiagnostic,validateModuleDrainDiagnostic,validateModuleExchangeDiagnostic,moduleExchangeDiagnostic} from '../src/module-exchange-diagnostic.mjs'
import {ConversationLifetimes} from '../src/conversation-lifetimes.mjs'

async function fixture(t,{busy=false,holding=null}={}){
 const root=await mkdtemp(join(tmpdir(),'module-drain-'));await mkdir(join(root,'state'))
 const admission=new ConversationLifetimes(),children=[],controls=[]
 let release
 const held=new Promise(resolve=>{release=resolve})
 const actualDrain=admission.drain.bind(admission)
 admission.drain=ticket=>busy&&admission.snapshot().active?Promise.resolve({status:'busy'}):actualDrain(ticket)
 const reap=c=>{
  if(c.exitCode!==null)return
  c.exitCode=0;c.connected=false;c.stdout.closed=c.stderr.closed=true
  c.stdout.emit('close');c.stderr.emit('close');c.emit('exit',0,null);c.emit('close',0,null)
 }
 const controller=createModuleProcess({component:'conversation',root,admission,
  prepareRelease:async versionId=>({versionId,appRoot:'/run/bellteam-maintenance/conversation/releases/'+versionId+'/payload'}),
  validateReady:()=>{},
  spawnProcess:(_path,args)=>{
   const c=Object.assign(new EventEmitter(),{connected:true,exitCode:null,signalCode:null,versionId:args[0]==='builtin'?null:args[0],
    stdout:Object.assign(new EventEmitter(),{closed:false,resume(){}}),stderr:Object.assign(new EventEmitter(),{closed:false,resume(){}})})
   c.kill=()=>{reap(c);return true};c.disconnect=()=>reap(c);children.push(c);return c
  },
  createChannel:c=>({ready:Promise.resolve({versionId:c.versionId,protocolVersion:1}),
   control:async method=>{controls.push(method);if(method==='quiesce'&&holding==='child_quiesce')return held;
    if(method==='exit')queueMicrotask(()=>reap(c));return {resumed:true,quiesced:true}},
   request:()=>holding==='parent_drain'?held:Promise.resolve(null),drainIncoming:async()=>{},reaped:async()=>{}}),
 })
 t.after(async()=>{release({quiesced:true});await controller.close();await rm(root,{recursive:true,force:true})})
 await controller.start()
 return {controller,admission,children,controls,release}
}

test('explicit busy resumes the old generation without issuing quiesce or exiting the accepted writer',async t=>{
 const f=await fixture(t,{busy:true}),old=f.children[0],lease=f.admission.enter()
 try{
  await assert.rejects(f.controller.replace('a'.repeat(64)),error=>{
   assert.equal(error.code,'CONVERSATION_DRAIN_TIMEOUT')
   assert.deepEqual(error.moduleDiagnostic,{schema:'bellteam.module-drain-diagnostic.v1',component:'conversation',stage:'parent_drain',
    runnerActive:0,admissionActive:1,admissionClosed:true,admissionUnconfirmed:false})
   assert.equal(validateModuleExchangeDiagnostic(error.moduleDiagnostic),true);return true
  })
  assert.equal(f.controls.includes('quiesce'),false);assert.equal(f.controls.includes('exit'),false)
  assert.equal(f.children.length,1);assert.equal(f.children[0],old);assert.equal(f.controller.snapshot().available,true)
  assert.equal(f.controller.snapshot().currentVersionId,null)
 }finally{f.admission.finish(lease)}
})

for(const stage of ['parent_drain','child_quiesce'])test('timeout retains private '+stage+' counts before old resume without cancelling accepted completion',async t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 const f=await fixture(t,{holding:stage})
 let request
 if(stage==='parent_drain')request=f.controller.request('synthetic',{})
 const replacing=f.controller.replace('a'.repeat(64));replacing.catch(()=>{})
 await new Promise(resolve=>setImmediate(resolve))
 t.mock.timers.tick(60000)
 await assert.rejects(replacing,error=>{
  assert.equal(error.code,'CONVERSATION_DRAIN_TIMEOUT');assert.equal(error.moduleDiagnostic.stage,stage)
  assert.equal(error.moduleDiagnostic.runnerActive,1);assert.equal(error.moduleDiagnostic.admissionActive,0)
  assert.equal(error.moduleDiagnostic.admissionClosed,true);assert.equal(validateModuleDrainDiagnostic(error.moduleDiagnostic),true)
  assert.doesNotMatch(JSON.stringify(error.moduleDiagnostic),/generation|lease|correlation|synthetic|stack|message/)
  return true
 })
 assert.equal(f.controller.snapshot().available,true);assert.equal(f.admission.snapshot().closed,false)
 assert.equal(f.children.length,1);assert.equal(f.controls.includes('exit'),false)
 if(stage==='parent_drain')assert.equal(f.controls.includes('quiesce'),false)
 let settled=false;request?.then(()=>{settled=true});await Promise.resolve();assert.equal(settled,false)
 f.release({quiesced:true});if(request)await request
})

test('private drain union remains closed, tolerates missing snapshot, and keeps legacy exchange v1 intact',()=>{
 const value=moduleDrainDiagnostic('conversation','parent_drain',1,{snapshot:()=>({active:2,closed:true,unconfirmed:false,generation:'private',lease:'private'})})
 assert.equal(validateModuleDrainDiagnostic(value),true);assert.equal(validateModuleExchangeDiagnostic(value),true)
 assert.doesNotMatch(JSON.stringify(value),/private|generation|lease/)
 const missing=moduleDrainDiagnostic('conversation','child_quiesce',0,{snapshot:()=>{throw Error('private')}})
 assert.deepEqual([missing.admissionActive,missing.admissionClosed,missing.admissionUnconfirmed],[null,null,null])
 assert.equal(validateModuleDrainDiagnostic(missing),true)
 for(const patch of [{stage:'private'}, {runnerActive:-1}, {admissionActive:Infinity}, {admissionClosed:'secret'},
  {message:'private'}, {component:'unknown'}, {runnerActive:Number.MAX_SAFE_INTEGER+1}])assert.equal(validateModuleDrainDiagnostic({...value,...patch}),false)
 const legacy=moduleExchangeDiagnostic('conversation','initialize',{code:'EIO'},null,null)
 assert.equal(validateModuleExchangeDiagnostic(legacy),true);assert.equal(validateModuleDrainDiagnostic(legacy),false)
 assert.equal(validateModuleExchangeDiagnostic({...legacy,stage:'parent_drain'}),false)
})
