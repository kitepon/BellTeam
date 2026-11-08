import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtemp,mkdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {observeModuleChild,reportModuleChildExit} from '../src/module-child-restart.mjs'
import {createModuleProcess} from '../src/module-process.mjs'
import {validateModuleChildExitDiagnostic} from '../src/diagnostics.mjs'

const child=()=>Object.assign(new EventEmitter(),{stdout:Object.assign(new EventEmitter(),{closed:false,resume(){}}),
 stderr:Object.assign(new EventEmitter(),{closed:false,resume(){}})})
const gc=(before=4053.3)=>`[1493:0x123] 54008 ms: Mark-Compact ${before} (4140.0) -> 4033.9 (4138.5) MB, pooled: 0 MB, 2338.21 / 0.00 ms secret-path`
const heap='FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'
const snapshot=(observation,signal='SIGABRT')=>({schema:'bellteam.module-child-exit.v1',component:'usage',exitCode:null,signal,...observation})

test('whole large chunks and split markers retain only bounded closed OOM/GC evidence',()=>{
 const c=child(),observe=observeModuleChild(c)
 const first=Buffer.from('private body '+'x'.repeat(20000)+'\n'+gc()+'\nERR_IPC_CHANNEL_')
 const second=Buffer.from('CLOSED\n'+heap.slice(0,25)),third=Buffer.from(heap.slice(25)+'\n'+'z'.repeat(20000))
 for(const raw of [first,second,third])c.stderr.emit('data',raw)
 c.stderr.closed=true;c.stderr.emit('close');c.emit('close')
 const result=observe()
 assert.deepEqual(result.stderrCodes,['ERR_IPC_CHANNEL_CLOSED'])
 assert.equal(result.stderrBytes,first.length+second.length+third.length)
 assert.equal(result.stderrTruncated,true);assert.equal(result.reason,'heap_out_of_memory')
 assert.deepEqual(result.stderrTail,[{kind:'gc',beforeMiB:4053.3,afterMiB:4033.9,capacityMiB:4138.5,pauseMs:2338.21},{kind:'heap_oom'}])
 assert.equal(validateModuleChildExitDiagnostic(snapshot(result)),true)
 assert.doesNotMatch(JSON.stringify(result),/private|body|secret|0x123|1493|xxxxx|zzzzz/)
 const capped=child(),read=observeModuleChild(capped)
 capped.stderr.emit('data',Buffer.from(Array.from({length:12},(_,i)=>gc(i)).join('\n')+'\n'+heap))
 capped.stderr.closed=true;capped.stderr.emit('close') // IPC close is not required to flush the stderr tail.
 assert.equal(read().stderrTail.length,8);assert.equal(read().stderrTruncated,true)
 assert.equal(read().stderrTail.at(-1).kind,'heap_oom')
 assert.equal(read().stderrTail[0].beforeMiB,5)
 const unknown=child(),readUnknown=observeModuleChild(unknown)
 unknown.stderr.emit('data',Buffer.from('private arbitrary number 9000\n'+gc(1e10)))
 unknown.stderr.closed=true;unknown.stderr.emit('close')
 assert.deepEqual(readUnknown().stderrTail,[]);assert.equal(readUnknown().reason,'unknown')
 assert.equal(validateModuleChildExitDiagnostic(snapshot(readUnknown(),'SIGKILL')),true)
 const worker=child(),readWorker=observeModuleChild(worker)
 worker.stderr.emit('data',Buffer.from('x'.repeat(12000)+'ERR_WORKER_OUT_OF_MEMORY'+'y'.repeat(12000)))
 assert.equal(readWorker().reason,'worker_out_of_memory')
})

test('one real controller close reports after pipes, ignores callback failure, resumes and suppresses intentional exits',async t=>{
 const root=await mkdtemp(join(tmpdir(),'child-exit-observation-'));await mkdir(join(root,'state'))
 const children=[],reports=[],consoleRows=[]
 t.mock.method(console,'error',value=>consoleRows.push(JSON.parse(value)))
 t.mock.timers.enable({apis:['setTimeout']})
 const reap=(c,unexpected=false)=>{
  if(c.exitCode!==null)return
  c.exitCode=unexpected?null:0;c.signalCode=unexpected?'SIGABRT':null;c.connected=false
  c.stdout.closed=c.stderr.closed=true;c.stdout.emit('close');c.stderr.emit('close')
  c.emit('exit',c.exitCode,c.signalCode);c.emit('close',c.exitCode,c.signalCode)
 }
 const controller=createModuleProcess({component:'diagnostics',root,
  prepareRelease:async()=>assert.fail('builtin needs no release'),validateReady:()=>{},
  onModuleChildExit:value=>{reports.push(value);throw Error('private callback failure')},
  spawnProcess:()=>{
   const c=child();Object.assign(c,{exitCode:null,signalCode:null,connected:true,kill:()=>{reap(c);return true},disconnect:()=>reap(c)})
   children.push(c);return c
  },
  createChannel:c=>({ready:Promise.resolve({versionId:null,protocolVersion:1}),
   control:async method=>{if(method==='exit')queueMicrotask(()=>reap(c));return {resumed:true,quiesced:true}},
   reaped:async()=>{},drainIncoming:async()=>{},request:async()=>null}),
 })
 t.after(async()=>{await controller.close();await rm(root,{recursive:true,force:true})})
 await controller.start();assert.equal(controller.snapshot().available,true)
 children[0].stderr.emit('data',Buffer.from(gc()+'\n'+heap))
 assert.equal(reports.length,0)
 reap(children[0],true)
 for(let i=0;i<20;i++)await Promise.resolve()
 assert.equal(reports.length,1);assert.equal(validateModuleChildExitDiagnostic(reports[0]),true)
 assert.equal(reports[0].reason,'heap_out_of_memory')
 t.mock.timers.tick(1000)
 for(let i=0;i<40;i++)await Promise.resolve()
 assert.equal(children.length,2);assert.equal(controller.snapshot().available,true)
 await controller.close();assert.equal(reports.length,1);assert.equal(consoleRows.length,1)
 const c=child(),read=observeModuleChild(c)
 c.stderr.emit('data',Buffer.from('ERR_WORKER_OUT_OF_MEMORY'))
 reportModuleChildExit('members',{code:null,signal:'SIGABRT'},read(),()=>Promise.reject(Error('callback rejection')))
 await new Promise(resolve=>setImmediate(resolve))
 assert.equal(consoleRows.at(-1).code,'MODULE_CHILD_EXITED')
 assert.doesNotMatch(JSON.stringify(consoleRows),/private|callback|secret-path/)
})

test('the conversation exit-origin line reaches the diagnostic DTO as the closed pair only',async()=>{
 const c=child(),read=observeModuleChild(c)
 c.stderr.emit('data',Buffer.from(JSON.stringify({code:'CONVERSATION_CHILD_EXIT_ORIGIN',origin:'peer_failure',failureCode:'CONVERSATION_IPC_INVALID'})+'\n'))
 c.stderr.closed=true;c.stderr.emit('close')
 const sent=[];reportModuleChildExit('conversation',{code:0,signal:null},read(),dto=>{sent.push(dto)})
 assert.deepEqual(sent[0].childExitOrigin,{origin:'peer_failure',failureCode:'CONVERSATION_IPC_INVALID'})
 assert.equal(sent[0].reason,'unknown');assert.equal(validateModuleChildExitDiagnostic(sent[0]),true)
 const quiet=child(),readQuiet=observeModuleChild(quiet);quiet.stderr.closed=true;quiet.stderr.emit('close')
 const plain=[];reportModuleChildExit('members',{code:1,signal:null},readQuiet(),dto=>{plain.push(dto)})
 assert.equal(Object.hasOwn(plain[0],'childExitOrigin'),false);assert.equal(validateModuleChildExitDiagnostic(plain[0]),true)
})
