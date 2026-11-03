import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { SecretRequests } from '../src/secret-requests.mjs'
import { createOlrwAuthConsumer } from '../src/usage/olrw-auth-consumer.mjs'
import { AitermClient } from '../src/aiterm-client.mjs'

const binding = { session_id: 'auth-synthetic', launch_id: 'synthetic-launch', metadata_identity: 'synthetic-metadata', native_id: '$10', pane_id: '%10', server_pid: 100, server_started: 'birth1', pane_pid: 101, pane_started: 'birth2' }
const url = 'https://claude.ai/oauth/authorize?synthetic=owner-only'
function result(stage = 'paste_code', b = binding, overrides = {}) {
  return { structuredContent: { schema: 'aiterm.agent-auth-result.v1', harness: 'claude-code', session_id: b.session_id,
    status: stage === 'complete' ? 'authenticated' : 'waiting',
    auth_ui: { schema: 'aiterm.auth-ui.v1', binding: b, stage, title: '合成認証', message: '', url: stage === 'paste_code' ? url : null,
      user_code: null, input: stage === 'paste_code' ? 'authorization_code' : null, prompt_digest: stage === 'paste_code' ? 'a'.repeat(64) : null, choices: [] }, ...overrides } }
}
const cleanup = { structuredContent: { schema: 'aiterm.agent-auth-result.v1', harness: 'claude-code', session_id: null, status: 'blocked' } }
async function until(predicate) {
  for (let n = 0; n < 10000; n++) { if (await predicate()) return; await setImmediate() }
  assert.fail('synthetic fixture did not reach state')
}
async function fixture(t, { native = {}, authorization = async () => {}, expiry = 900000 } = {}) {
  const base = join(import.meta.dirname, '../.olrw-fixture')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'run-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const notifications = [], changes = [], calls = []
  const bots = new Map([['bot-synthetic', { id: 'bot-synthetic', name: '合成' }]])
  const secrets = new SecretRequests({ root, bots, rooms: { refresh() {}, get() { return { memberIds: ['bot-synthetic'] } } }, notify: item => notifications.push(item) })
  await secrets.initialize()
  secrets.watch(event => changes.push(event))
  const auth = Object.fromEntries(['start', 'status', 'respond', 'cleanup'].map(action => [action, async args => {
    calls.push({ action, args: structuredClone(args) })
    return native[action] ? native[action](args) : action === 'cleanup' ? cleanup : action === 'respond' ? result('complete') : result()
  }]))
  const context = { runId: 'run-synthetic', requesterBotId: 'bot-synthetic', toolId: 'olrw-auth', sessionId: binding.session_id,
    expiresAt: new Date(Date.now() + expiry).toISOString(), protectedHosted: 'original-synthetic', roomId: null }
  const runDirectory = join(root, 'state/olrw-auth')
  const make = (change = {}) => createOlrwAuthConsumer({ secretRequests: secrets, runDirectory, context, assertAuthorized: authorization, auth, ...change })
  const consumer = make()
  const pending = consumer.execute()
  t.after(() => consumer.close())
  const request = async () => { await until(() => [...secrets.items.values()].some(x => x.status === 'pending')); return [...secrets.items.values()][0] }
  const guide = async item => { let value; await until(async () => (value = await consumer.ownerSecretGuide({ requestId: item.id, botId: item.botId, roomId: item.roomId })) !== null); return value }
  const journal = async () => (await readFile(join(runDirectory, context.runId + '.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  return { root, secrets, calls, notifications, changes, context, consumer, make, pending, request, guide, journal, runDirectory }
}

test('whole flow exposes URL only in Owner guide and consumes once after durable intent', async t => {
  const f = await fixture(t)
  const item = await f.request()
  assert.deepEqual(await f.guide(item), { url })
  assert.ok(f.changes.length >= 2)
  assert.equal(JSON.stringify([item, f.changes, f.notifications, f.secrets.timeline({ botId: item.botId })]).includes(url), false)
  assert.equal(await f.consumer.ownerSecretGuide({ requestId: item.id, botId: 'other', roomId: null }), null)
  assert.equal(await f.consumer.ownerSecretGuide({ requestId: item.id, botId: item.botId, roomId: 'other' }), null)
  await f.secrets.submit(item.id, 'SYNTHETIC-CODE')
  assert.deepEqual(await f.pending, { runId: f.context.runId, outcome: 'confirmed', reason: 'authenticated_and_closed' })
  assert.deepEqual(f.calls.map(x => x.action), ['start', 'status', 'respond', 'cleanup'])
  assert.equal(f.calls[2].args.response.value, 'SYNTHETIC-CODE')
  const records = await f.journal()
  assert.ok(records.some(x => x.intent === 'respond' && x.consumed))
  assert.equal(JSON.stringify(records).includes('SYNTHETIC-CODE'), false)
  assert.equal(await f.consumer.ownerSecretGuide({ requestId: item.id, botId: item.botId, roomId: null }), null)
  assert.equal((await f.make().execute()).outcome, 'not_issued')
  assert.equal(f.calls.length, 4)
})

for (const [action, schema, effect] of [
  ['respond', 'aiterm.auth-response-error.v1', 'not_issued'], ['respond', 'aiterm.auth-response-error.v1', 'unknown'],
  ['status', 'aiterm.auth-operation-error.v1', 'not_issued'], ['cleanup', 'aiterm.auth-operation-error.v1', 'unknown'],
]) test(`${action} preserves ${effect} and stops all continuation/restart`, async t => {
  const f = await fixture(t, { native: { [action]: () => ({ isError: true, structuredContent: {
    schema, harness: 'claude-code', session_id: binding.session_id, action: action === 'cleanup' ? 'cancel' : action,
    code: action === 'respond' ? 'SYNTHETIC_FAILURE' : effect === 'not_issued' ? 'AGENT_AUTH_OPERATION_NOT_ISSUED' : 'AGENT_AUTH_OPERATION_UNKNOWN', effect } }) } })
  const item = await f.request(); await f.guide(item); await f.secrets.submit(item.id, 'SYNTHETIC-CODE')
  const r = await f.pending
  assert.equal(r.outcome, effect)
  const count = f.calls.length
  assert.equal((await f.make().execute()).outcome, 'not_issued')
  assert.equal(f.calls.length, count)
  assert.equal((await f.journal()).at(-1).phase, effect)
})

test('native transport exception is unknown and its text/properties never escape', async t => {
  const f = await fixture(t, { native: { start() { throw Object.assign(new Error(url), { reason: 'SYNTHETIC-CODE' }) } } })
  const receipt = await f.pending
  assert.equal(receipt.outcome, 'unknown')
  assert.equal(JSON.stringify([receipt, await f.journal()]).includes('SYNTHETIC-CODE'), false)
  assert.deepEqual(f.calls.map(x => x.action), ['start'])
})

test('unknown/unauthorized origins never create a secret card', async t => {
  const bad = result(); bad.structuredContent.auth_ui.url = 'https://claude.ai.attacker.test/code'
  const f = await fixture(t, { native: { start: () => bad } })
  assert.equal((await f.pending).outcome, 'unknown')
  assert.equal(f.secrets.items.size, 0)
  assert.equal(f.calls.length, 1)
})

test('owner guide checks live authorization and close hides guide without cancel', async t => {
  let denied = false
  const f = await fixture(t, { authorization: () => { if (denied) throw Error('synthetic-denial') } })
  const item = await f.request(); await f.guide(item)
  denied = true
  assert.equal(await f.consumer.ownerSecretGuide({ requestId: item.id, botId: item.botId, roomId: null }), null)
  f.consumer.close()
  await f.pending
  assert.deepEqual(f.calls.map(x => x.action), ['start'])
  assert.ok(['interrupted', 'request_unavailable'].includes((await f.journal()).at(-1).reason))
})

test('cancelled secret, wrong owner, and tampered path never respond', async t => {
  for (const fault of ['cancel', 'owner', 'path']) {
    const sub = await fixture(t)
    const item = await sub.request(); await sub.guide(item)
    if (fault === 'cancel') await sub.secrets.cancel(item.id)
    else {
      await sub.secrets.submit(item.id, 'SYNTHETIC-CODE')
      if (fault === 'owner') sub.secrets.items.get(item.id).botId = 'other'
      else sub.secrets.items.get(item.id).path = join(sub.root, 'untrusted')
    }
    assert.notEqual((await sub.pending).outcome, 'confirmed')
    assert.ok(!sub.calls.some(x => x.action === 'respond'))
  }
})

test('fresh prompt mismatch stops before reading/sending secret', async t => {
  const wrong = result(); wrong.structuredContent.auth_ui.binding = { ...binding, native_id: '$other' }
  const f = await fixture(t, { native: { status: () => wrong } })
  const item = await f.request(); await f.guide(item); await f.secrets.submit(item.id, 'SYNTHETIC-CODE')
  assert.equal((await f.pending).reason, 'stale_binding')
  assert.ok(!f.calls.some(x => x.action === 'respond'))
})

test('normal transition permits only pane birth change and requires a subsequent fresh status', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const next = { ...binding, pane_pid: 102, pane_started: 'next-birth' }
  let statuses = 0
  const f = await fixture(t, { native: {
    status() {
      statuses++; t.mock.timers.tick(5000)
      return statuses === 1 ? result('waiting', next, { binding_transition: { kind: 'login_to_onboarding', from: binding, to: next } }) : result('paste_code', next)
    }, respond: () => result('complete', next),
  } })
  const item = await f.request(); await f.guide(item); await f.secrets.submit(item.id, 'SYNTHETIC-CODE')
  assert.equal((await f.pending).outcome, 'confirmed')
  assert.equal(statuses, 2)
  assert.deepEqual(f.calls.find(x => x.action === 'respond').args.binding, next)
  const logs = await f.journal()
  assert.ok(logs.some(x => x.stage === 'waiting' && x.digest === null))
})

test('status budget is at most twelve with at least five seconds spacing', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const stamps = []
  const f = await fixture(t, { native: { start: () => result('waiting'), status() { stamps.push(Date.now()); t.mock.timers.tick(5000); return result('waiting') } } })
  assert.equal((await f.pending).reason, 'budget_exhausted')
  assert.equal(stamps.length, 12)
  assert.ok(stamps.slice(1).every((x, i) => x - stamps[i] >= 5000))
})

test('input deadline hides guide and stops without native cleanup', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const f = await fixture(t)
  const item = await f.request(); await f.guide(item)
  t.mock.timers.tick(600001)
  assert.equal(await f.consumer.ownerSecretGuide({ requestId: item.id, botId: item.botId, roomId: null }), null)
  assert.notEqual((await f.pending).outcome, 'confirmed')
  assert.deepEqual(f.calls.map(x => x.action), ['start'])
})

test('cross-run target lock blocks another caller, expired plans issue zero native', async t => {
  const f = await fixture(t)
  await f.guide(await f.request())
  assert.equal((await f.make({ context: { ...f.context, runId: 'second' } }).execute()).outcome, 'not_issued')
  f.consumer.close(); await f.pending
  const g = await fixture(t, { expiry: -1 })
  assert.equal((await g.pending).outcome, 'not_issued')
  assert.equal(g.calls.length, 0)
})

test('same-generation prompt or OAuth URL changes do not consume the old code', async t => {
  for (const field of ['prompt_digest', 'url']) {
    const next = result()
    next.structuredContent.auth_ui[field] = field === 'url' ? 'https://claude.ai/new-oauth' : 'b'.repeat(64)
    const f = await fixture(t, { native: { status: () => next } })
    const item = await f.request(); await f.guide(item); await f.secrets.submit(item.id, 'SYNTHETIC-CODE')
    assert.equal((await f.pending).reason, 'stale_prompt')
    assert.ok(!f.calls.some(x => x.action === 'respond'))
    assert.equal((await f.journal()).at(-1).consumed, false)
  }
})

test('intent is durable before native, abort in-flight stays unknown and does not cleanup', async t => {
  let entered
  const reached = new Promise(resolve => { entered = resolve })
  const f = await fixture(t, { native: { async start() { entered(); return new Promise(() => {}) } } })
  await reached
  assert.equal((await f.journal()).at(-1).intent, 'start')
  f.consumer.close()
  assert.equal((await f.pending).outcome, 'unknown')
  assert.equal((await f.make().execute()).outcome, 'not_issued')
  assert.deepEqual(f.calls.map(x => x.action), ['start'])
})

test('disk claim failure and authorization denial issue zero native', async t => {
  const denied = await fixture(t, { authorization: () => { throw Error('synthetic') } })
  assert.equal((await denied.pending).outcome, 'not_issued')
  assert.equal(denied.calls.length, 0)
  const f = await fixture(t)
  await f.guide(await f.request())
  const root = join(f.root, 'invalid-disk')
  await writeFile(root, 'synthetic')
  assert.equal((await f.make({ runDirectory: root }).execute()).outcome, 'not_issued')
  assert.equal(f.calls.length, 1)
  f.consumer.close(); await f.pending
})

test('missing or invalid secret file is consumed but never sent, and no secret hash is recorded', async t => {
  const f = await fixture(t, { native: { async status() {
    const item = [...f.secrets.items.values()][0]
    await writeFile(item.path, 'INVALID\nCODE', { mode: 0o600 })
    return result()
  } } })
  const item = await f.request(); await f.guide(item); await f.secrets.submit(item.id, 'SYNTHETIC-CODE')
  assert.equal((await f.pending).reason, 'invalid_secret')
  assert.equal(f.calls.some(x => x.action === 'respond'), false)
  const records = await f.journal()
  assert.equal(records.at(-1).consumed, true)
  assert.equal(JSON.stringify(records).includes('SYNTHETIC-CODE'), false)
})

test('unknown choices require intervention without auto-response or cleanup', async t => {
  const selection = result('select')
  Object.assign(selection.structuredContent.auth_ui, { input: 'choice', prompt_digest: 'b'.repeat(64), choices: [{ id: 'option-1', label: '合成選択' }] })
  const f = await fixture(t, { native: { start: () => selection } })
  assert.equal((await f.pending).reason, 'intervention_required')
  assert.deepEqual(f.calls.map(x => x.action), ['start'])
  assert.equal(f.secrets.items.size, 0)
})

test('transition cannot replace native/server identity', async t => {
  const wrong = { ...binding, server_pid: 999, pane_pid: 103 }
  const f = await fixture(t, { native: { status: () => result('waiting', wrong, { binding_transition: { kind: 'login_to_onboarding', from: binding, to: wrong } }) } })
  const item = await f.request(); await f.guide(item); await f.secrets.submit(item.id, 'SYNTHETIC-CODE')
  assert.equal((await f.pending).outcome, 'unknown')
  assert.equal(f.calls.some(x => x.action === 'respond' || x.action === 'cleanup'), false)
})

const operationFaults = {
  unknown_not_issued: r => { r.code = 'AGENT_AUTH_OPERATION_UNKNOWN' },
  not_issued_unknown: r => { r.effect = 'unknown' },
  unknown_code: r => { r.code = 'SYNTHETIC_UNKNOWN_CODE' },
  extra_field: r => { r.extra = 'SYNTHETIC' },
  missing_field: r => { delete r.action },
  wrong_action: r => { r.action = 'start' },
  wrong_harness: r => { r.harness = 'codex-cli' },
  wrong_session: r => { r.session_id = 'other-session' },
}
for (const action of ['status', 'cleanup']) {
  for (const [name, mutate] of Object.entries(operationFaults)) test(`operation-error strict ${action}: ${name}`, async t => {
    const r = { schema: 'aiterm.auth-operation-error.v1', harness: 'claude-code', session_id: binding.session_id,
      action: action === 'cleanup' ? 'cancel' : 'status', code: 'AGENT_AUTH_OPERATION_NOT_ISSUED', effect: 'not_issued' }
    mutate(r)
    const f = await fixture(t, { native: { [action]: () => ({ isError: true, structuredContent: r }) } })
    const item = await f.request(); await f.guide(item); await f.secrets.submit(item.id, 'SYNTHETIC-CODE')
    assert.deepEqual(await f.pending, { runId: f.context.runId, outcome: 'unknown', reason: 'invalid_receipt' })
    assert.equal(f.calls.at(-1).action, action)
    const count = f.calls.length
    assert.equal((await f.make().execute()).outcome, 'not_issued')
    assert.equal(f.calls.length, count)
  })
  for (const effect of ['not_issued', 'unknown']) test(`operation-error strict ${action}: valid ${effect}`, async t => {
    const code = effect === 'not_issued' ? 'AGENT_AUTH_OPERATION_NOT_ISSUED' : 'AGENT_AUTH_OPERATION_UNKNOWN'
    const f = await fixture(t, { native: { [action]: () => ({ isError: true, structuredContent: {
      schema: 'aiterm.auth-operation-error.v1', harness: 'claude-code', session_id: binding.session_id,
      action: action === 'cleanup' ? 'cancel' : 'status', code, effect } }) } })
    const item = await f.request(); await f.guide(item); await f.secrets.submit(item.id, 'SYNTHETIC-CODE')
    assert.equal((await f.pending).outcome, effect)
    assert.equal(f.calls.at(-1).action, action)
  })
}

for (const code of ['AITERM_AUTH_CONNECTION_ARGUMENTS', 'AITERM_AUTH_CONNECTION_UNCONFIRMED', 'AITERM_AUTH_SERVER_VERSION_UNCONFIRMED']) {
  test(`local auth guard ${code} is separate from native receipt and consumes permission`, async t => {
    const client = new AitermClient({ command: 'must-not-spawn', env: {} })
    let connects = 0, rpcs = 0
    const transport = { pid: 123 }
    const sdk = { transport, getServerVersion: () => ({ name: 'aiterm', version: 'synthetic-version' }),
      callTool() { rpcs++; assert.fail('guard must reject before RPC') } }
    client.client = sdk; client.transport = transport
    client.connect = () => { connects++; assert.fail('guard must not connect') }
    let options = { expectedAuthConnection: sdk, expectedAuthServerVersion: 'synthetic-version' }
    if (code === 'AITERM_AUTH_CONNECTION_ARGUMENTS') options = { expectedAuthServerVersion: 'synthetic-version' }
    else if (code === 'AITERM_AUTH_CONNECTION_UNCONFIRMED') client.client = null
    else options.expectedAuthServerVersion = 'other-version'
    const f = await fixture(t, { native: { respond: () => client.call('agent_auth', { action: 'respond' }, options) } })
    const item = await f.request(); await f.guide(item); await f.secrets.submit(item.id, 'SYNTHETIC-CODE')
    assert.deepEqual(await f.pending, { runId: f.context.runId, outcome: 'not_issued', reason: 'local_not_issued' })
    assert.equal(connects, 0); assert.equal(rpcs, 0)
    assert.equal(f.calls.at(-1).action, 'respond')
    const count = f.calls.length
    const state = (await f.journal()).at(-1)
    assert.equal(state.consumed, true); assert.equal(state.counts.respond, 1)
    assert.equal((await f.make().execute()).outcome, 'not_issued')
    assert.equal(f.calls.length, count)
  })
}

for (const [label, failure] of [
  ['unknown code', Object.assign(Error('SYNTHETIC'), { code: 'SYNTHETIC_UNKNOWN', effect: 'not_issued' })],
  ['contradictory effect', Object.assign(Error('SYNTHETIC'), { code: 'AITERM_AUTH_CONNECTION_UNCONFIRMED', effect: 'unknown' })],
  ['missing effect', Object.assign(Error('SYNTHETIC'), { code: 'AITERM_AUTH_CONNECTION_UNCONFIRMED' })],
  ['plain object', { code: 'AITERM_AUTH_CONNECTION_UNCONFIRMED', effect: 'not_issued' }],
  ['transport exception', Error('SYNTHETIC_TRANSPORT_FAILURE')],
]) test(`local auth guard ${label} stays unknown with no continuation`, async t => {
  const f = await fixture(t, { native: { respond: () => { throw failure } } })
  const item = await f.request(); await f.guide(item); await f.secrets.submit(item.id, 'SYNTHETIC-CODE')
  assert.deepEqual(await f.pending, { runId: f.context.runId, outcome: 'unknown', reason: 'native_unconfirmed' })
  assert.equal(f.calls.at(-1).action, 'respond')
  const count = f.calls.length
  assert.equal((await f.journal()).at(-1).consumed, true)
  assert.equal((await f.make().execute()).outcome, 'not_issued')
  assert.equal(f.calls.length, count)
})
