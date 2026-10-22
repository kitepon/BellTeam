import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ExecutionBridge, deliveryExecutionRef, roomExecutionRef, callExecutionRef, EXECUTION_META, BINDING_META, ERROR_META, SOURCE_META } from '../src/execution-bridge.mjs'
import { AitermClient, AitermTransport } from '../src/aiterm-transport.mjs'

const A = { session_id: 'bot-a', launch_id: 'a'.repeat(32) }, B = { session_id: 'bot-b', launch_id: 'b'.repeat(32) }
const target = { launch: B, boundary: { event_cursor: 7, operation_id: null, turn_id: 'native-1', steer_id: null } }
const source = { status: 'verified', reason: 'matched', point: { launch: A, boundary: null }, boundary_status: 'missing' }
const typed = (code, effect = 'not_started') => ({ isError: true, content: [{ type: 'text', text: code }],
  _meta: { [ERROR_META]: { schema: 'aiterm.execution-error.v1', code, effect, follow_up: effect === 'possible' ? 'status_only' : 'none' } } })
const request = deliveryExecutionRef('delivery-1', B.session_id)
function fixture({ send = null, completion = 'completed', fence = 'closed' } = {}) {
  const calls = []; let record
  const binding = () => ({ schema: 'aiterm.execution-binding.v1', request, source, target, phase: 'invoked' })
  const client = { async call(name, args, options) {
    calls.push({ name, args, options })
    if (name === 'agent_execution') {
      if (args.action === 'register') record = { schema: 'aiterm.execution-record.v1', reservation: args.reservation,
        source_session_id: A.session_id, source, stopping: false,
        operations: { launch: 'not_issued', send: 'not_issued' },
        relation: { request, source_session_id: A.session_id, source: source.point, target: null, phase: 'reserved', completion: 'open', target_fence: 'open', lifecycle: 'tracking' } }
      if (args.action === 'finish') Object.assign(record.relation, { completion, target_fence: fence, lifecycle: fence === 'closed' ? 'retired' : 'tracking' })
      return { structuredContent: structuredClone(record), _meta: { [BINDING_META]: binding() } }
    }
    if (send) return send(name, args, options)
    record.relation.target = target; record.relation.phase = 'invoked'; record.operations.send = 'accepted'
    return { structuredContent: { mode: 'agent_dispatch', event_cursor: 7, wait_process: { executable: 'fixture', args: [] } },
      _meta: { [BINDING_META]: binding(), 'aiterm/steer_follow': { keep: true }, 'aiterm/interim_words': { keep: true } } }
  } }
  const bridge = new ExecutionBridge(client)
  return { bridge, calls, client, binding, reserve: () => bridge.reserve({ request, sourceSession: A.session_id, source: { launch: A, boundary: null }, targetSession: B.session_id, expectedLaunch: B.launch_id }) }
}

test('既存delivery/room target/call seqを使い、新しいIDや本文queueを作らない', () => {
  assert.deepEqual(roomExecutionRef('room-message', 'bot-b'), { kind: 'room', message_id: 'room-message', target_session_id: 'bot-b' })
  assert.deepEqual(callExecutionRef({ sessionId: 'call-1', event: 'session.reply', seq: 3, deliveryId: 'fallback' }, 'bot-b'),
    { kind: 'call', call_session_id: 'call-1', event: 'session.reply', seq: 3, target_session_id: 'bot-b' })
  assert.deepEqual(callExecutionRef({ sessionId: 'call-1', event: 'session.reply', deliveryId: 'fallback' }, 'bot-b'), deliveryExecutionRef('fallback', 'bot-b'))
  assert.throws(() => deliveryExecutionRef('', 'bot-b'), { code: 'EXECUTION_INVALID' })
})

test('reservationを先に登録し、同じ元参照をsend metaへ渡して既存steer/interimを保持する', async () => {
  const f = fixture(), handle = await f.reserve()
  assert.deepEqual(f.calls.map(c => c.name), ['agent_execution'])
  const result = await handle.invoke('pty_send', { session_id: B.session_id, text: 'synthetic' }, { meta: { 'aiterm/caller': 'BellTeam', fixture: 1 } })
  assert.deepEqual(f.calls[1].options.meta, { 'aiterm/caller': 'BellTeam', fixture: 1,
    [EXECUTION_META]: { schema: 'aiterm.execution-ref.v1', request } })
  assert.equal(handle.trackingError, null); assert.deepEqual(handle.binding.target, target)
  assert.equal(result._meta['aiterm/steer_follow'].keep, true)
  assert.equal(result._meta['aiterm/interim_words'].keep, true)
  const finished = await handle.finish({ kind: 'completion', target })
  assert.equal(finished.relation.lifecycle, 'retired')
})

test('host source contextはregister claimと分離し、未指定をclaimから補わない', async () => {
  const f = fixture()
  await f.reserve()
  assert.deepEqual(f.calls[0].options.meta[SOURCE_META], { schema: 'aiterm.execution-source.v1', source: null })
  const context = structuredClone(source.point)
  const claimed = { launch: { ...A, launch_id: 'c'.repeat(32) }, boundary: null }
  const pending = f.bridge.reserve({ request, sourceSession: A.session_id, source: claimed, targetSession: B.session_id }, {
    sourceContext: context, meta: { keep: 'host', [SOURCE_META]: { schema: 'forged', source: claimed } },
  })
  context.launch.launch_id = 'd'.repeat(32)
  await pending
  assert.deepEqual(f.calls[1].args.reservation.source, claimed)
  assert.equal(Object.hasOwn(f.calls[1].args, 'sourceContext'), false)
  assert.deepEqual(f.calls[1].options.meta, { keep: 'host', [SOURCE_META]: {
    schema: 'aiterm.execution-source.v1', source: source.point,
  } })
  await assert.rejects(f.bridge.reserve({ request, targetSession: B.session_id }, { sourceContext: { launch: A } }), { code: 'EXECUTION_INVALID', effect: 'not_started' })
  assert.equal(f.calls.length, 2)
})

test('成功receiptにbinding失敗が付いても捨てず、再送せずstatusだけを使う', async () => {
  const receipt = { structuredContent: { mode: 'agent_dispatch', event_cursor: 7, wait_process: { executable: 'fixture', args: [] } },
    _meta: { [ERROR_META]: typed('EXECUTION_UNCONFIRMED', 'possible')._meta[ERROR_META], other: 'preserved' } }
  const f = fixture({ send: () => receipt }), handle = await f.reserve()
  assert.equal(await handle.invoke('pty_send', { session_id: B.session_id }), receipt)
  assert.equal(handle.trackingError, 'EXECUTION_UNCONFIRMED'); assert.equal(handle.binding, null)
  await assert.rejects(handle.finish({ kind: 'completion', target }), { code: 'EXECUTION_UNCONFIRMED' })
  await assert.rejects(handle.invoke('pty_send', { session_id: B.session_id }), { code: 'EXECUTION_UNCONFIRMED' })
  await handle.status()
  assert.deepEqual(f.calls.map(c => c.name), ['agent_execution', 'pty_send', 'agent_execution'])
})

test('typed拒否・possible・通信欠測を区別し、いずれもsendを自動再実行しない', async () => {
  for (const [effect, send] of [
    ['not_started', () => typed('EXECUTION_STOPPING')],
    ['possible', () => typed('EXECUTION_UNCONFIRMED', 'possible')],
    ['possible', () => { throw Error('synthetic timeout') }],
  ]) {
    const f = fixture({ send }), handle = await f.reserve()
    await assert.rejects(handle.invoke('pty_send', { session_id: B.session_id }), e => e.effect === effect)
    assert.equal(f.calls.filter(c => c.name === 'pty_send').length, 1)
  }
})

test('Aitermの失敗理由をcauseへ残し、元の受付分類と送信1回を維持する', async () => {
  for (const withTypedError of [true, false]) {
    const result = { isError: true, content: [{ type: 'text', text: 'native input failed after partial paste' }],
      ...(withTypedError ? { _meta: typed('EXECUTION_BUSY', 'possible')._meta } : {}) }
    const f = fixture({ send: () => result }), handle = await f.reserve()
    await assert.rejects(handle.invoke('pty_send', { session_id: B.session_id }), error => {
      assert.equal(error.code, withTypedError ? 'EXECUTION_BUSY' : 'EXECUTION_UNCONFIRMED')
      assert.equal(error.effect, 'possible')
      assert.equal(error.cause?.message, 'native input failed after partial paste')
      return true
    })
    assert.equal(f.calls.filter(call => call.name === 'pty_send').length, 1)
  }
})

test('register応答欠測で実行へ進まず、受付済みかは既存参照のstatusで調べる', async () => {
  const calls = [], f = fixture()
  const bridge = new ExecutionBridge({ async call(name, args) {
    calls.push(name)
    const result = await f.client.call(name, args)
    if (args.action === 'register') throw Error('synthetic lost reply')
    return result
  } })
  await assert.rejects(bridge.reserve({ request, targetSession: B.session_id, expectedLaunch: B.launch_id }), { effect: 'possible' })
  assert.equal((await bridge.status(request)).schema, 'aiterm.execution-record.v1')
  assert.deepEqual(calls, ['agent_execution', 'agent_execution'])
})

test('doneでもtarget fence未確認ならtrackingのまま返し、Bridgeで退役を推定しない', async () => {
  const f = fixture({ fence: 'unknown' }), handle = await f.reserve()
  await handle.invoke('pty_send', { session_id: B.session_id })
  const record = await handle.finish({ kind: 'completion', target })
  assert.equal(record.relation.completion, 'completed'); assert.equal(record.relation.lifecycle, 'tracking')
  await assert.rejects(handle.finish({ kind: 'queue_disappeared' }), { code: 'EXECUTION_INVALID' })
})

test('違う元参照・target世代の結合情報は採用せず、成功した元の作用は保持する', async () => {
  for (const change of [binding => { binding.request.delivery_id = 'other' }, binding => { binding.target.launch.launch_id = 'c'.repeat(32) }]) {
    const f = fixture(), handle = await f.reserve(), call = f.client.call
    f.client.call = async (...args) => {
      const result = structuredClone(await call(...args)); change(result._meta[BINDING_META]); return result
    }
    const result = await handle.invoke('pty_send', { session_id: B.session_id })
    assert.equal(result.structuredContent.mode, 'agent_dispatch'); assert.equal(handle.binding, null)
    assert.equal(handle.trackingError, 'EXECUTION_UNCONFIRMED')
  }
})

test('agent_stop v2は旧v1の閉鎖と部分結果を新中断へ流用しない', async () => {
  const base = { schema: 'aiterm.cascade-stop-result.v1', roots: [A], status: 'stopped', relation_coverage: 'complete', unresolved: [], targets: [{ launch: A, outcome: 'closed', reason: 'closed' }] }
  for (const change of [r => { r.roots = [B] }, r => { r.targets = [] }, r => { r.relation_coverage = 'incomplete' }, r => { r.unresolved = [{ request, reason: 'missing' }] }]) {
    const result = structuredClone(base); change(result)
    const bridge = new ExecutionBridge({ async call() { return { structuredContent: result } } })
    await assert.rejects(bridge.interrupt([A]), { code: 'EXECUTION_UNCONFIRMED' })
  }
  const partial = { ...base, status: 'partial', relation_coverage: 'incomplete', unresolved: [{ request, reason: 'missing' }] }
  await assert.rejects(new ExecutionBridge({ async call() { return { structuredContent: partial } } }).interrupt([A]), { code: 'EXECUTION_UNCONFIRMED' })
})

test('prompt付きlaunchの後に同じ参照の本文を重ねて送らない', async () => {
  const f = fixture(), handle = await f.reserve()
  await handle.invoke('agent_launch', { session_name: B.session_id, prompt: 'synthetic' })
  await assert.rejects(handle.invoke('pty_send', { session_id: B.session_id }), { code: 'EXECUTION_CONFLICT' })
  assert.equal(f.calls.filter(c => c.name === 'pty_send').length, 0)
})

test('予約と違う席へのlaunch/sendは発行前に拒み、元の参照を流用しない', async () => {
  const f = fixture(), handle = await f.reserve()
  await assert.rejects(handle.invoke('pty_send', { session_id: 'other' }), { code: 'EXECUTION_INVALID', effect: 'not_started' })
  await assert.rejects(handle.invoke('agent_launch', { session_name: 'other' }), { code: 'EXECUTION_INVALID', effect: 'not_started' })
  assert.equal(f.calls.length, 1)
})

test('空launchのRPC欠測中は次のsendへ進まず、prompt launchはbinding欠測でも再送しない', async () => {
  const f = fixture({ send: () => { throw Error('synthetic lost launch') } }), handle = await f.reserve()
  await assert.rejects(handle.invoke('agent_launch', { session_name: B.session_id }), { effect: 'possible' })
  await assert.rejects(handle.invoke('pty_send', { session_id: B.session_id }), { code: 'EXECUTION_UNCONFIRMED' })
  assert.equal(f.calls.filter(c => c.name === 'pty_send').length, 0)
})

test('roots読取は期待世代をそのまま返し、空・別席・世代欠測を停止成功へ変換しない', async () => {
  const base = { schema: 'aiterm.execution-roots.v1', session_id: A.session_id, observation: 'absent', current: null,
    roots: [A], relation_coverage: 'complete', unresolved: [] }
  const calls = []
  const bridge = new ExecutionBridge({ async call(name, args) { calls.push([name, args]); return { structuredContent: base } } })
  assert.deepEqual((await bridge.roots(A.session_id)).roots, [A])
  assert.deepEqual(calls, [['agent_execution_roots', { session_id: A.session_id }]])
  base.roots = []; assert.equal((await bridge.roots(A.session_id)).roots.length, 0)
  base.roots = [B]; await assert.rejects(bridge.roots(A.session_id), { code: 'EXECUTION_UNCONFIRMED' })
  base.roots = []; base.observation = 'unknown'
  await assert.rejects(bridge.roots(A.session_id), { code: 'EXECUTION_UNCONFIRMED' })
})

test('preparingの状態照会は作用確定に昇格させず、欠測したlaunchからsendへ進まない', async () => {
  const f = fixture({ send: () => { throw Error('synthetic lost launch response') } })
  const handle = await f.reserve()
  await assert.rejects(handle.invoke('agent_launch', { session_name: B.session_id }), { effect: 'possible' })
  const call = f.client.call
  f.client.call = async (...args) => {
    const result = await call(...args)
    if (args[1]?.action === 'status') result.structuredContent.operations.launch = 'preparing'
    return result
  }
  assert.equal((await handle.status()).operations.launch, 'preparing')
  await assert.rejects(handle.invoke('pty_send', { session_id: B.session_id }), { code: 'EXECUTION_UNCONFIRMED' })
  assert.equal(f.calls.filter(call => call.name === 'pty_send').length, 0)
})

test('引数付きstdio入口を短命env起動へ引継ぎmetaを保持し、possible返却は同名再利用を止める', { timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-wire-child-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const sdk = new URL('../node_modules/@modelcontextprotocol/sdk/dist/esm/server/', import.meta.url)
  const path = join(root, 'synthetic-mcp')
  await writeFile(path, '#!/usr/bin/env node\n' + `
(async()=>{
  const {McpServer}=await import(${JSON.stringify(new URL('mcp.js', sdk).href)});
  const {StdioServerTransport}=await import(${JSON.stringify(new URL('stdio.js', sdk).href)});
  const {z}=await import(${JSON.stringify(new URL('../node_modules/zod/index.js', import.meta.url).href)});
  const server=new McpServer({name:'synthetic-wire',version:'1'});
  server.registerTool('agent_launch',{inputSchema:{session_name:z.string(),env_vars:z.array(z.string()).optional()}},async(args,extra)=>({content:[],structuredContent:{session_id:args.session_name,meta:extra._meta,argv:process.argv.slice(2)}}));
  server.registerTool('agent_execution',{inputSchema:{action:z.literal('register'),source_session_id:z.string().nullable(),reservation:z.any(),env_vars:z.array(z.string()).optional()}},async(args,extra)=>({content:[],structuredContent:{schema:'aiterm.execution-record.v1',reservation:args.reservation,source:${JSON.stringify({ ...source, status: 'unknown', reason: 'caller_unbound', point: null })},relation:{request:args.reservation.request,target:null,phase:'reserved',completion:'open',target_fence:'unknown',lifecycle:'tracking'}},_meta:{received:extra._meta}}));
  server.registerTool('pty_close',{inputSchema:{session_id:z.string()}},async()=>(${JSON.stringify(typed('EXECUTION_UNCONFIRMED', 'possible'))}));
  await server.connect(new StdioServerTransport());
})();\n`, { mode: 0o700 })
  const client = new AitermClient({ command: process.execPath, args: [path, '--native-execution-fixture'] }); t.after(() => client.close())
  const meta = { 'aiterm/caller': 'BellTeam', [EXECUTION_META]: { schema: 'aiterm.execution-ref.v1', request } }
  const result = await client.call('agent_launch', { session_name: B.session_id }, { env: { PATH: process.env.PATH, BELLTEAM_ROOT: root }, meta })
  assert.deepEqual(result.structuredContent.meta, meta)
  assert.deepEqual(result.structuredContent.argv, ['--native-execution-fixture'])
  // The server observes metadata on a separate env-launched stdio connection;
  // it does not promote the claim or this synthetic context to verified.
  const registers = []
  const bridge = new ExecutionBridge({ async call(...args) {
    const result = await client.call(...args); registers.push(result); return result
  } })
  const handle = await bridge.reserve({ request, sourceSession: A.session_id, source: source.point, targetSession: B.session_id }, {
    env: { PATH: process.env.PATH, BELLTEAM_ROOT: root }, sourceContext: source.point,
  })
  assert.deepEqual(registers[0]._meta.received[SOURCE_META], { schema: 'aiterm.execution-source.v1', source: source.point })
  assert.equal(handle.record.source.status, 'unknown')
  const transport = new AitermTransport({ client })
  const bot = { id: 'synthetic', session: 'synthetic' }
  await assert.rejects(transport.changeSession(bot, 'pty_close', { session_id: bot.session }), e => e.aitermResponseReturned && e.executionError.effect === 'possible')
  await assert.rejects(transport.ensure(bot), { code: 'BOT_SESSION_UNCONFIRMED' })
})
