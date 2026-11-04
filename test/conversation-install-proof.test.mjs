import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModuleProcess } from '../src/module-process.mjs'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'
const tick = () => new Promise(resolve => setImmediate(resolve))
for (const mode of ['success', 'callback_failure', 'child_loss', 'completion_hold', 'already_closed']) test('held writer proof: '+mode, async t => {
  const root = await mkdtemp(join(tmpdir(),'writer-proof-')); await mkdir(join(root,'state'))
  const admission = new ConversationLifetimes(), calls = [], children = []
  const quiesceDone = Promise.withResolvers(), incoming = Promise.withResolvers(), release = Promise.withResolvers()
  let entered = false, heldAssert, mutexCalls = 0
  const actionDone = Promise.withResolvers(), resumeDone = Promise.withResolvers()
  let proofSettled = false
  const end = child => {
    child.exitCode = 0; child.connected = false; child.stdout.closed = child.stderr.closed = true
    child.stdout.emit('close'); child.stderr.emit('close'); child.emit('exit',0,null); child.emit('close',0,null)
  }
  t.mock.method(console,'error',()=>{})
  const controller = createModuleProcess({component:'conversation',root,admission,
    exchangeMutex:{runExclusive(){mutexCalls++; assert.fail('proof must not reacquire parent mutex')}},
    prepareRelease:async()=>{},validateReady:()=>{},
    spawnProcess:()=>{
      const child=Object.assign(new EventEmitter(),{connected:true,exitCode:null,signalCode:null,
        stdout:Object.assign(new EventEmitter(),{closed:false,resume(){}}),stderr:Object.assign(new EventEmitter(),{closed:false,resume(){}})})
      child.disconnect=()=>end(child);child.kill=()=>{end(child);return true};children.push(child);return child
    },
    createChannel:child=>({ready:Promise.resolve({versionId:null,protocolVersion:1}),
      control:method=>{
        calls.push(method)
        if(method==='exit')queueMicrotask(()=>end(child))
        const result=Promise.resolve({resumed:true,quiesced:true})
        if(method==='quiesce')result.completion=quiesceDone.promise
        if(mode==='completion_hold' && method==='resume' && entered)result.completion=resumeDone.promise
        return result
      },request:async()=>null,callback:async()=>null,
      drainIncoming:()=>incoming.promise,reaped:async()=>{},
    }),
  })
  t.after(async()=>{quiesceDone.resolve();incoming.resolve();release.resolve();await controller.close().catch(()=>{});await rm(root,{recursive:true,force:true})})
  await controller.start()
  if(mode==='already_closed'){
    admission.close('module_replace')
    await assert.rejects(controller.withInstallReconciliationProof(()=>assert.fail('borrowed closed ticket')),/NOT_ACCEPTED/)
    assert.equal(calls.includes('quiesce'),false);return
  }
  const proof=controller.withInstallReconciliationProof(check=>{
    const operation=(async()=>{
    entered=true;heldAssert=check;assert.equal(check(),true)
    assert.throws(()=>admission.enter())
    await release.promise
    if(mode==='callback_failure')throw Error('callback failed')
    return 'fenced'
    })()
    if(mode==='completion_hold')operation.completion=actionDone.promise
    return operation
  })
  void proof.then(()=>{proofSettled=true},()=>{proofSettled=true})
  const outcome=['success','completion_hold'].includes(mode)?proof:assert.rejects(proof,mode==='callback_failure'?/callback failed/:/PROOF_UNAVAILABLE/)
  await tick();assert.ok(calls.includes('quiesce'));assert.equal(entered,false)
  await assert.rejects(controller.withInstallReconciliationProof(()=>assert.fail('nested proof')),/UPDATE_IN_PROGRESS/)
  quiesceDone.resolve();await tick();assert.equal(entered,false,'incoming effects must finish after actual quiesce completion')
  incoming.resolve();await tick();assert.equal(entered,true)
  if(mode==='child_loss'){end(children[0]);await tick();assert.throws(heldAssert,/PROOF_UNAVAILABLE/)}
  await assert.rejects(controller.callback('synthetic',{}),/PROOF_UNAVAILABLE/)
  release.resolve()
  if(mode==='completion_hold'){
    await tick();assert.equal(proofSettled,false);assert.equal(calls.at(-1),'quiesce')
    actionDone.resolve();await tick();assert.equal(calls.at(-1),'resume');assert.equal(proofSettled,false)
    assert.throws(()=>admission.enter());await assert.rejects(controller.callback('synthetic',{}),/PROOF_UNAVAILABLE/);resumeDone.resolve()
  }
  const result=await outcome
  if(['success','completion_hold'].includes(mode))assert.equal(result,'fenced')
  assert.throws(heldAssert,/PROOF_UNAVAILABLE/,'escaped assertion must expire')
  assert.equal(mutexCalls,0);assert.equal(children.length,1)
  if(mode!=='child_loss'){
    assert.equal(controller.snapshot().available,true)
    const lease=admission.enter();admission.finish(lease)
    assert.equal(calls.at(-1),'resume')
  }else assert.equal(controller.snapshot().available,false)
})
