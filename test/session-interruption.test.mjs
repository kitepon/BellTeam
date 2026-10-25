import test from 'node:test'
import assert from 'node:assert/strict'
import { ExecutionBridge } from '../src/execution-bridge.mjs'

const A = { session_id: 'synthetic-a', launch_id: 'a'.repeat(32) }
const B = { session_id: 'synthetic-b', launch_id: 'b'.repeat(32) }
const run = { launch: A, boundary: { event_cursor: 3, operation_id: null, turn_id: 'native-turn', steer_id: null } }
const target = { launch: A, run, key: 'Escape', key_receipt: 'accepted', interruption: 'interrupted', session_preserved: 'confirmed', reason: 'native-proof' }
const response = () => ({ schema: 'aiterm.cascade-stop-result.v2', mode: 'interrupt', roots: [A], status: 'confirmed', relation_coverage: 'complete', unresolved: [], targets: [structuredClone(target)] })
const bridge = (value, calls = []) => new ExecutionBridge({ async call(name, args) { calls.push({ name, args }); return { structuredContent: value } } })

test('v2だけを1回要求し、run中断とsession維持の両確認を読む', async () => {
  const calls = [], value = response()
  assert.equal(await bridge(value, calls).interrupt([A]), value)
  assert.deepEqual(calls, [{ name: 'agent_stop', args: { schema: 'aiterm.cascade-stop-request.v2', mode: 'interrupt', roots: [A] } }])
})
test('旧close成功/absent結果を中断成功へ流用しない', async () => {
  for (const outcome of ['closed', 'already_closed', 'absent']) {
    const value = { schema: 'aiterm.cascade-stop-result.v1', roots: [A], status: 'stopped', relation_coverage: 'complete', unresolved: [], targets: [{ launch: A, outcome }] }
    await assert.rejects(bridge(value).interrupt([A]), { code: 'EXECUTION_UNCONFIRMED' })
  }
})
test('キー受付だけ、run欠測、会話維持欠測をconfirmedにしない', async () => {
  for (const change of [t => { t.interruption = 'unconfirmed' }, t => { t.run = null }, t => { t.run.boundary = null }, t => { t.session_preserved = 'unconfirmed' }, t => { t.key = null }]) {
    const value = response(); change(value.targets[0])
    await assert.rejects(bridge(value).interrupt([A]), { code: 'EXECUTION_UNCONFIRMED' })
  }
})
test('unsupported/not_sentは未確認のまま返し、closeや別キーを呼ばない', async () => {
  const calls = [], value = response()
  Object.assign(value, { status: 'unconfirmed', relation_coverage: 'incomplete', unresolved: [{ request: null, reason: 'adapter_missing' }] })
  Object.assign(value.targets[0], { run: null, key: null, key_receipt: 'not_sent', interruption: 'unsupported', session_preserved: 'unconfirmed' })
  assert.equal((await bridge(value, calls).interrupt([A])).status, 'unconfirmed')
  assert.equal(calls.length, 1)
})
test('局所already_idleで下流不明を消さず、キーも送らない', async () => {
  const value = response()
  Object.assign(value, { status: 'unconfirmed', relation_coverage: 'incomplete', unresolved: [{ request: null, reason: 'child_unknown' }] })
  Object.assign(value.targets[0], { run: null, key: null, key_receipt: 'not_sent', interruption: 'already_idle' })
  assert.equal((await bridge(value).interrupt([A])).unresolved.length, 1)
  value.targets[0].key = 'Escape'; value.targets[0].key_receipt = 'accepted'
  await assert.rejects(bridge(value).interrupt([A]), { code: 'EXECUTION_UNCONFIRMED' })
})
test('同名別世代、別run、root取り違えは成功として読まない', async () => {
  for (const change of [r => { r.roots = [B] }, r => { r.targets[0].launch = B }, r => { r.targets[0].run.launch = B }, r => { r.targets = [] }]) {
    const value = response(); change(value)
    await assert.rejects(bridge(value).interrupt([A]), { code: 'EXECUTION_UNCONFIRMED' })
  }
})
test('部分確認は部分のまま、coverage不足やunresolvedを全確認へ丸めない', async () => {
  const value = response(); value.status = 'partial'; value.relation_coverage = 'incomplete'; value.unresolved = [{ request: null, reason: 'missing' }]
  assert.equal((await bridge(value).interrupt([A])).status, 'partial')
  value.status = 'confirmed'; await assert.rejects(bridge(value).interrupt([A]), { code: 'EXECUTION_UNCONFIRMED' })
})
test('通信断/typed拒否は再送せず、実行方式を変えない', async () => {
  for (const error of [null, { schema: 'aiterm.execution-error.v1', code: 'EXECUTION_UNSUPPORTED', effect: 'not_started', follow_up: 'none' }]) {
    const calls = []
    const client = { async call(name) { calls.push(name); if (!error) throw Error('synthetic connection lost'); return { isError: true, _meta: { 'aiterm/execution_error': error } } } }
    await assert.rejects(new ExecutionBridge(client).interrupt([A]), { code: error?.code ?? 'EXECUTION_UNCONFIRMED' })
    assert.deepEqual(calls, ['agent_stop'])
  }
})
