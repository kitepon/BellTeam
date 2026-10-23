import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createManagedTransport } from '../src/aiterm-transport.mjs'
import { BINDING_META, EXECUTION_META, ERROR_META, CLOSED_LAUNCH_META } from '../src/execution-bridge.mjs'
import { BellTeamMessenger } from '../src/messenger.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'

const id = '11111111-1111-4111-8111-111111111111'
const A = { session_id: 'bot-a', launch_id: 'a'.repeat(32) }
const B = { session_id: 'bot-b', launch_id: 'b'.repeat(32) }
const source = { status: 'verified', reason: 'matched', boundary_status: 'missing', point: { launch: A, boundary: null } }
const request = { kind: 'delivery', delivery_id: id, target_session_id: B.session_id }
const refused = code => ({ isError: true, content: [{ type: 'text', text: code }], _meta: { [ERROR_META]: {
  schema: 'aiterm.execution-error.v1', code, effect: 'not_started', follow_up: 'none',
} } })
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls = [], bodies = []
  const record = {
    schema: 'aiterm.execution-record.v1', source_session_id: A.session_id, source, stopping: false,
    reservation: { schema: 'aiterm.execution-reservation.v1', request, source: source.point,
      target: { session_id: B.session_id, expected_launch_id: null } },
    operations: { launch: 'unknown', send: 'not_issued' },
    relation: { request, source_session_id: A.session_id, source: source.point, target: null,
      phase: 'reserved', completion: 'open', target_fence: 'open', lifecycle: 'tracking' },
  }
  let pause = null, refusal = null, alterReceipt = null, closes = 0
  const binding = () => ({ schema: 'aiterm.execution-binding.v1', request, source,
    phase: record.relation.phase, target: record.relation.target })
  const result = () => ({ structuredContent: structuredClone(record), _meta: { [BINDING_META]: binding() } })
  const client = { async call(name, args, options) {
    calls.push({ name, args: structuredClone(args), options: structuredClone(options) })
    if (name === 'agent_execution') {
      assert.notEqual(args.action, 'register', '元の予約を再登録しない')
      assert.deepEqual(args.request, request)
      if (args.action === 'close_launch') {
        if (pause) await pause
        if (refusal) return refused(refusal)
        if (closes || record.operations.launch !== 'unknown' || record.operations.send !== 'not_issued') return refused('EXECUTION_CONFLICT')
        assert.deepEqual(args.target, B)
        closes++
        const value = result()
        value._meta[CLOSED_LAUNCH_META] = {
          schema: 'aiterm.closed-launch.v1', version: 1, action: 'close_launch', outcome: 'closed', request, target: B,
          management_ref: { kind: 'mcp', process_pid: 123, process_started_identity: 'fake-process', request_id: 9, tool: 'pty_close', target_session_id: B.session_id },
          evidence: { native: { schema: 'aiterm.execution-native.v1', native_id: '$4', server: { pid: 45, started_identity: 'fake-server' } },
            initial_prompt: 'none', initial_prompt_delivery: null, harness_alive: false, absence_confirmed: true, metadata_committed: true },
        }
        const detached = structuredClone(value)
        return alterReceipt ? alterReceipt(detached) : detached
      }
      if (args.action === 'reconcile_launch') {
        if (pause) await pause
        if (refusal) return refused(refusal)
        if (record.operations.send !== 'not_issued') return refused('EXECUTION_CONFLICT')
        assert.deepEqual(args.target, B)
        record.operations.launch = 'accepted'
        record.relation.target = { launch: B, boundary: null }
        return alterReceipt ? alterReceipt(result()) : result()
      }
      if (args.action === 'finish') Object.assign(record.relation, { completion: 'completed', target_fence: 'closed', lifecycle: 'retired' })
      return result()
    }
    if (name === 'pty_send') {
      assert.equal(record.operations.send, 'not_issued')
      assert.deepEqual(options.meta[EXECUTION_META].request, request)
      assert.deepEqual(record.reservation.source, source.point)
      record.operations.send = 'accepted'
      record.relation.target = { launch: B, boundary: { event_cursor: 1, operation_id: null, turn_id: 'fixture-turn', steer_id: null } }
      record.relation.phase = 'invoked'
      bodies.push(args.text)
      return { structuredContent: { mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: 'fake', args: [] } },
        _meta: { [BINDING_META]: binding() } }
    }
    if (name === 'pty_observe' || name === 'pty_read') return { content: [] }
    assert.fail(`起動やcloseなどの別操作を発行しない: ${name}`)
  } }
  const transport = createManagedTransport({ client })
  transport.waitUntilDone = async () => ({ turn_id: 'fixture-turn' })
  const bots = new Map([['bot-a', { id: 'bot-a', name: '現在の名前', session: A.session_id }],
    ['bot-b', { id: 'bot-b', name: '宛先', session: B.session_id }]])
  const messenger = new BellTeamMessenger({ bots, transport, logPath: join(root, 'messages.jsonl'),
    deliveryId: () => { throw new Error('新しい配送IDを作らない') } })
  await messenger.append({ schema: 'bellteam.direct-message.v1', delivery_id: id, from: 'bot-a', target: 'bot-b',
    message: '保存した人工本文', from_identity: { id: 'bot-a', name: '送信時の名前' }, image: false, delivery: 'failed', at: new Date().toISOString() })
  transport.uncertainChanges.set('bot-b', 'agent_launch', request)
  return { root, bots, transport, messenger, client, calls, bodies, record,
    get closes() { return closes },
    pause(value) { pause = value }, refuse(value) { refusal = value }, receipt(fn) { alterReceipt = fn } }
}

test('HTTPの明示再開は保存済みの元配送・本文・送信時の名を使い、一度だけ通常sendへ渡す', async t => {
  const f = await fixture(t)
  const server = createBellTeamServer({ ...f, store: f.messenger.store, authorize: () => true })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/api/deliveries/direct/${id}/resume`
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: B, message: '置換しない本文' }) })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).delivery_id, id)
  await f.transport.idle('bot-b')
  assert.deepEqual(f.bodies, ['「送信時の名前」からあなたへ次のメッセージが届いています。\n\n保存した人工本文'])
  const records = await f.messenger.store.records()
  assert.equal(records.length, 1); assert.equal(records[0].delivery_id, id); assert.equal(records[0].delivery, 'delivered')
  assert.equal(f.transport.uncertainChanges.has('bot-b'), false)
  const again = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: B }) })
  assert.equal(again.status, 409); assert.equal(f.bodies.length, 1)
  assert.deepEqual(f.calls.filter(c => c.name === 'agent_execution').map(c => c.args.action), ['status', 'reconcile_launch', 'finish'])
})

for (const reason of ['EXECUTION_STALE_GENERATION', 'EXECUTION_STOPPING', 'EXECUTION_UNSUPPORTED']) {
  test(`${reason}は状態不明と元のfailedを残し、本文を発行しない`, async t => {
    const f = await fixture(t); f.refuse(reason)
    await assert.rejects(f.messenger.resumeDelivery(id, B), { code: reason })
    assert.equal(f.transport.uncertainChanges.get('bot-b'), 'agent_launch')
    assert.equal(f.bodies.length, 0); assert.equal((await f.messenger.store.records())[0].delivery, 'failed')
  })
}

test('不正な照合receiptは起動成功とせず、元予約の差し替えも受けない', async t => {
  const f = await fixture(t)
  f.receipt(value => { value.structuredContent.reservation.source = { launch: null, boundary: null }; return value })
  await assert.rejects(f.messenger.resumeDelivery(id, B), { code: 'EXECUTION_UNCONFIRMED' })
  assert.equal(f.transport.uncertainChanges.has('bot-b'), true); assert.equal(f.bodies.length, 0)
})

test('同時の再開と途中停止は後続本文を発行せず、停止後の不明を解除しない', async t => {
  const f = await fixture(t)
  let release; f.pause(new Promise(resolve => { release = resolve }))
  const first = f.transport.reconcileLaunch(f.bots.get('bot-b'), request, B)
  await assert.rejects(f.transport.reconcileLaunch(f.bots.get('bot-b'), request, B), { code: 'EXECUTION_BUSY' })
  f.transport.stopVersions.set('bot-b', 1); release()
  await assert.rejects(first, { code: 'BOT_STOPPED' })
  assert.equal(f.transport.uncertainChanges.has('bot-b'), true); assert.equal(f.bodies.length, 0)
})

test('close/configureの不明や別Botの指定には回復APIを呼ばない', async t => {
  const f = await fixture(t)
  for (const cause of ['pty_close', 'agent_configure', 'legacy_change_pending']) {
    f.transport.uncertainChanges.set('bot-b', cause)
    await assert.rejects(f.messenger.resumeDelivery(id, B), { code: 'BOT_SESSION_UNCONFIRMED' })
  }
  f.transport.uncertainChanges.set('bot-b', 'agent_launch')
  await assert.rejects(f.messenger.resumeDelivery(id, A), { code: 'BOT_SESSION_UNCONFIRMED' })
  assert.equal(f.calls.length, 0)
})

test('既にsend acceptedの記録は、履歴failedが残っていても再送しない', async t => {
  const f = await fixture(t); f.record.operations.send = 'accepted'
  await assert.rejects(f.messenger.resumeDelivery(id, B), { code: 'EXECUTION_CONFLICT' })
  assert.equal(f.bodies.length, 0); assert.equal(f.transport.uncertainChanges.has('bot-b'), true)
})

test('明示closeは元unknownを保持し、本文や新配送を発行せず正規closed証明だけを返す', async t => {
  const f = await fixture(t)
  const original = structuredClone(f.record), history = await f.messenger.store.records()
  const server = createBellTeamServer({ ...f, store: f.messenger.store, authorize: () => true })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/api/deliveries/direct/${id}/close-launch`
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: B, message: '送らない' }) })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.delivery_id, id); assert.equal(result.closed.outcome, 'closed')
  assert.equal(f.closes, 1); assert.equal(f.transport.uncertainChanges.has('bot-b'), false)
  assert.deepEqual(f.record, original); assert.deepEqual(await f.messenger.store.records(), history); assert.deepEqual(f.bodies, [])
  assert.deepEqual(f.calls.map(call => [call.name, call.args.action]), [['agent_execution', 'status'], ['agent_execution', 'close_launch']])
  await assert.rejects(f.messenger.closeDeliveryLaunch(id, B), { code: 'EXECUTION_CONFLICT' })
  assert.equal(f.closes, 1)
})

for (const [name, alter] of Object.entries({
  schema: value => { value._meta[CLOSED_LAUNCH_META].schema = 'old' },
  version: value => { value._meta[CLOSED_LAUNCH_META].version = 2 },
  target: value => { value._meta[CLOSED_LAUNCH_META].target.launch_id = 'c'.repeat(32) },
  request: value => { value._meta[CLOSED_LAUNCH_META].request.delivery_id = 'other' },
  management: value => { value._meta[CLOSED_LAUNCH_META].management_ref.tool = 'pty_send' },
  native: value => { value._meta[CLOSED_LAUNCH_META].evidence.native.server.pid = 0 },
  prompt: value => { value._meta[CLOSED_LAUNCH_META].evidence.initial_prompt = 'sent' },
  alive: value => { value._meta[CLOSED_LAUNCH_META].evidence.harness_alive = true },
  absence: value => { value._meta[CLOSED_LAUNCH_META].evidence.absence_confirmed = false },
  commit: value => { value._meta[CLOSED_LAUNCH_META].evidence.metadata_committed = false },
  missing: value => { delete value._meta[CLOSED_LAUNCH_META] },
  original: value => { value.structuredContent.operations.launch = 'accepted' },
})) test(`不正なclose証明(${name})は不明を解除しない`, async t => {
  const f = await fixture(t)
  f.receipt(value => { alter(value); return value })
  await assert.rejects(f.messenger.closeDeliveryLaunch(id, B), { code: 'EXECUTION_UNCONFIRMED' })
  assert.equal(f.transport.uncertainChanges.get('bot-b'), 'agent_launch'); assert.deepEqual(f.bodies, [])
  assert.equal((await f.messenger.store.records())[0].delivery, 'failed')
})

test('closeの重複・途中停止と同じcauseの後発不明を先のreceiptで解消しない', async t => {
  for (const mutation of ['stop', 'same-cause', 'new-request']) {
    const f = await fixture(t)
    let release; f.pause(new Promise(resolve => { release = resolve }))
    const first = f.messenger.closeDeliveryLaunch(id, B)
    // Wait until the close RPC actually entered its artificial admission.
    while (!f.calls.some(call => call.args.action === 'close_launch')) await new Promise(resolve => setImmediate(resolve))
    await assert.rejects(f.messenger.closeDeliveryLaunch(id, B), { code: 'EXECUTION_BUSY' })
    if (mutation === 'stop') f.transport.stopVersions.set('bot-b', 1)
    else f.transport.uncertainChanges.set('bot-b', 'agent_launch', mutation === 'new-request' ? { ...request, delivery_id: 'new' } : request)
    release()
    await assert.rejects(first, { code: mutation === 'stop' ? 'BOT_STOPPED' : 'BOT_SESSION_UNCONFIRMED' })
    assert.equal(f.transport.uncertainChanges.get('bot-b'), 'agent_launch'); assert.deepEqual(f.bodies, [])
  }
})

test('close結果不明は再接続後も新配送を許さず、session-only closeへ迂回しない', async t => {
  const f = await fixture(t)
  f.transport.uncertainChanges.delete('bot-b')
  f.receipt(value => { delete value._meta[CLOSED_LAUNCH_META]; return value })
  await assert.rejects(f.messenger.closeDeliveryLaunch(id, B), { code: 'EXECUTION_UNCONFIRMED' })
  assert.equal(f.transport.uncertainChanges.get('bot-b'), 'close_launch')
  assert.throws(() => f.transport.requireSessionKnown('bot-b'), { code: 'BOT_SESSION_UNCONFIRMED' })
  assert.equal(f.calls.some(call => call.name === 'pty_close'), false)
})

test('未対応版・別requestの不明・作用済み本文にはcloseを発行しない', async t => {
  const f = await fixture(t)
  f.refuse('EXECUTION_UNSUPPORTED')
  await assert.rejects(f.messenger.closeDeliveryLaunch(id, B), { code: 'EXECUTION_UNSUPPORTED' })
  assert.equal(f.closes, 0); assert.equal(f.transport.uncertainChanges.has('bot-b'), true)
  f.calls.length = 0; f.refuse(null)
  for (const other of [null, { ...request, delivery_id: 'other' }]) {
    f.transport.uncertainChanges.set('bot-b', 'agent_launch', other)
    await assert.rejects(f.messenger.closeDeliveryLaunch(id, B), { code: 'BOT_SESSION_UNCONFIRMED' })
    assert.equal(f.calls.length, 0)
  }
  f.transport.uncertainChanges.set('bot-b', 'agent_launch', request); f.record.operations.send = 'accepted'
  await assert.rejects(f.messenger.closeDeliveryLaunch(id, B), { code: 'EXECUTION_CONFLICT' })
  assert.equal(f.closes, 0); assert.deepEqual(f.bodies, [])
})

test('生存再照合でも同名causeの後発不明を以前のreceiptで解除しない', async t => {
  const f = await fixture(t)
  let release; f.pause(new Promise(resolve => { release = resolve }))
  const first = f.transport.reconcileLaunch(f.bots.get('bot-b'), request, B)
  while (!f.calls.some(call => call.args.action === 'reconcile_launch')) await new Promise(resolve => setImmediate(resolve))
  f.transport.uncertainChanges.set('bot-b', 'agent_launch', request)
  release()
  await assert.rejects(first, { code: 'BOT_SESSION_UNCONFIRMED' })
  assert.equal(f.transport.uncertainChanges.has('bot-b'), true)
})
