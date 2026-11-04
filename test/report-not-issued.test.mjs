import test from 'node:test'
import assert from 'node:assert/strict'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'
const bot = { id: 'bot-a', session: 'bot-a', harness: 'codex' }, launch = 'a'.repeat(32)
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const done = () => ({ schema: 'aiterm.agent-wait-result.v1', outcome: 'done', session_id: bot.id, launch_id: launch, turn_id: 'turn-a' })
function fixture(t, { kinds = ['delivery.status'], dispatch = async () => ({ applied: true }), interim = [], ...options } = {}) {
  const gate = new ConversationLifetimes('builtin:test'), wait = deferred(), calls = []
  let native = 0
  const transport = new AitermTransport({ conversationAdmission: gate, handoffContext: async () => '',
    client: { async call(name) {
      calls.push(name)
      if (name === 'pty_send') { native++; assert.ok(gate.snapshot().active >= 2); return { structuredContent: { mode: 'agent_dispatch', session_id: bot.id, launch_id: launch, event_cursor: 10, wait_process: { executable: 'fake', args: [] } } } }
      if (name === 'pty_observe') return { _meta: { 'aiterm/interim_words': { schema: 'aiterm.interim-words.v1', event_cursor: 10, words: interim } } }
      if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', turn_id: 'turn-a', text: 'reply' } }
      if (name === 'pty_list') return { _meta: { 'aiterm/seat_turns': { schema: 'aiterm.seat-turns.v1', seats: [{ session_id: bot.id, launch_id: launch, harness: 'codex-cli', turn: { state: 'running', turn_id: 'turn-a', event_cursor: 10, wait_process: { executable: 'fake', args: [] } } }] } } }
      throw Error('unexpected ' + name)
    } }, waitProcess: () => wait.promise, ...options,
  })
  t.after(async () => { wait.resolve(done()); await transport.close() })
  const root = gate.enter(undefined, 'root-a'), delivery = gate.registerDelivery(root, { deliveryId: 'delivery-a', target: bot.id, kinds, dispatch })
  return { gate, wait, calls, transport, root, delivery, get native() { return native } }
}


const refusal = () => Object.assign(Error('local access unavailable'), {code:'HARNESS_AUTH_REQUIRED',status:403,effect:'not_started'})
async function report(f, options = {}) {
  return f.gate.runBackground(f.delivery, async () => {
    const report = f.gate.deriveReport(f.delivery, {deliveryId:'report-a',reason:'missing',kinds:['delivery.status'],dispatch:options.dispatch ?? (async () => ({applied:true}))})
    return f.transport.notifyReport(bot,'report request',{queue:{groupId:'report-a',context:'report'},conversationDelivery:report})
  })
}
test('report local refusal waits actual failure save ACK before returning unavailable', async t => {
  const saved=deferred(), entered=deferred(), error=refusal()
  const f=fixture(t,{kinds:[],requireAccess:async()=>{throw error}})
  let settled=false
  const result=report(f,{dispatch:async()=>{entered.resolve();return saved.promise}})
  result.then(()=>{settled=true},()=>{settled=true})
  await entered.promise;await tick();assert.equal(settled,false);assert.equal(f.native,0)
  saved.resolve({applied:true})
  assert.deepEqual(await result,{report:'unavailable',reason:'not_issued'})
  assert.equal(f.gate.inspectAdmission().failed,false)
  f.gate.finish(f.delivery);f.gate.finish(f.root);await tick();assert.equal(f.gate.snapshot().active,0)
})
test('failed status save remains original rejection and fails admission',async t=>{
 const error=refusal(),f=fixture(t,{kinds:[],requireAccess:async()=>{throw error}})
 await assert.rejects(report(f,{dispatch:async()=>{throw Error('save unknown')}}), e=>e===error)
 assert.equal(f.gate.inspectAdmission().failed,true);assert.equal(f.native,0)
 f.gate.finish(f.delivery);f.gate.finish(f.root)
})
test('dispatch-stage failure cannot use code, status, effect or absent receipt as proof',async t=>{
 const error=refusal(),f=fixture(t,{kinds:[]})
 let invoked=0
 f.transport.client.call=async name=>{assert.equal(name,'pty_send');invoked++;throw error}
 f.transport.isRunning=async()=>true
 await assert.rejects(report(f),e=>e===error)
 assert.equal(invoked,1);assert.equal(f.gate.inspectAdmission().failed,true)
 f.gate.finish(f.delivery);f.gate.finish(f.root)
})
test('ordinary notify keeps its original early rejection while save ACK is pending',async t=>{
 const error=refusal(),saved=deferred(),entered=deferred()
 const f=fixture(t,{requireAccess:async()=>{throw error},dispatch:async()=>{entered.resolve();return saved.promise}})
 const result=f.transport.notify(bot,'ordinary',{queue:{groupId:'delivery-a'},conversationDelivery:f.delivery})
 await assert.rejects(result,e=>e===error);await entered.promise
 saved.resolve({applied:true});await f.transport.idle(bot.id);await tick()
 f.gate.finish(f.root);assert.equal(f.gate.inspectAdmission().failed,false)
})
test('accepted report returns before its real native completion',async t=>{
 const f=fixture(t,{kinds:[]})
 assert.deepEqual(await report(f),{delivery:'running'})
 assert.equal(f.native,1);assert.ok(f.gate.snapshot().active>0)
 f.gate.finish(f.delivery);f.gate.finish(f.root);f.wait.resolve(done());await f.transport.idle(bot.id);await tick()
 assert.equal(f.gate.snapshot().active,0)
})
test('report without a registered status callback has no status save obligation',async t=>{
 const f=fixture(t,{kinds:[],requireAccess:async()=>{throw refusal()}})
 const result=await f.gate.runBackground(f.delivery,async()=>{
  const child=f.gate.deriveReport(f.delivery,{deliveryId:'report-a',reason:'missing',kinds:[],dispatch:async()=>assert.fail('no callback registered')})
  return f.transport.notifyReport(bot,'report request',{queue:{groupId:'report-a',context:'report'},conversationDelivery:child})
 })
 assert.deepEqual(result,{report:'unavailable',reason:'not_issued'});assert.equal(f.native,0)
 f.gate.finish(f.delivery);f.gate.finish(f.root);await tick();assert.equal(f.gate.snapshot().active,0)
})
