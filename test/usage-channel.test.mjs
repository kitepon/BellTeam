import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { deserialize, serialize } from 'node:v8'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fork } from 'node:child_process'
import { waitNotificationsChildClose } from '../src/notifications-ipc.mjs'
import { MODULE_PAYLOAD_LIMIT } from '../src/module-ipc.mjs'
import { createUsageParentChannel, createUsageChildChannel } from '../src/usage/channel.mjs'
import { createUsageChannelDispatcher } from '../src/usage/channel-dispatcher.mjs'
import { createUsageProjection } from '../src/usage/projection.mjs'
import { createUsageAuthority } from '../src/usage/authority.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); promise.catch(() => {}); return { promise, resolve, reject } }
const owner = { kind: 'owner', botId: null }, system = { kind: 'system', botId: null }, bot = { kind: 'bot', botId: 'bot-a' }
const bootstrap = { environment: {}, seatRuntime: false, subscription: {} }
function pair() {
  const a = new EventEmitter(), b = new EventEmitter()
  for (const [from, to] of [[a, b], [b, a]]) {
    from.connected = true
    from.send = (value, callback) => { const frame = deserialize(serialize(value)); queueMicrotask(() => { if (to.connected) to.emit('message', frame); callback?.() }) }
    from.disconnect = () => { if (!from.connected) return; from.connected = false; to.connected = false; from.emit('disconnect'); to.emit('disconnect') }
  }
  return [a, b]
}
async function fixture(t, options = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'bellteam-usage-channel-'))
  const actual = options.process ? fork(new URL('./fixtures/usage-channel-child.mjs', import.meta.url), [root], { serialization: 'advanced', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }) : null
  const ended = actual ? waitNotificationsChildClose(actual) : null
  let stderr = ''; actual?.stderr.on('data', data => { stderr += data })
  const [parentEndpoint, childEndpoint] = actual ? [actual, null] : pair()
  const generation = options.generation ?? 'generation-a', admission = new MembersAdmission(generation), authority = createUsageAuthority()
  const bots = new Map([['bot-a', { id: 'bot-a', name: 'A', harness: 'codex' }]])
  const projection = options.projection ?? createUsageProjection({ bots })
  const effects = [], changes = []
  const parent = createUsageParentChannel(parentEndpoint, { generation, admission, authorizeActor: authority.authorizeActor,
    onEffect: async (method, params, context) => {
      effects.push({ method, params });
      if (options.effect) { const value = await options.effect(method, params, context); if (value !== undefined) return value }
      if (method === 'members.read') return [...bots.values()]
      if (method === 'rooms.read') return []
      if (method === 'auth.call') return { structuredContent: { schema: 'aiterm.agent-auth-result.v1', status: 'waiting', session_id: 'auth-same' } }
      return null
    },
    onProjection: async (row, context) => {
      changes.push({ row, context }); await options.onProjection?.(row, context)
      if (context.phase === 'seed') projection.seed(row, generation)
      else projection.accept(row, generation)
    }, onSnapshotStart: () => projection.begin(generation), onSnapshotEnd: async context => { await options.onSnapshotEnd?.(context); projection.commit(generation) }, onSnapshotAbort: () => projection.discard(generation),
  })
  let child
  const dispatcher = createUsageChannelDispatcher({ root, effect: (...args) => child.effect(...args), projection: (...args) => child.projection(...args) })
  if (childEndpoint) child = createUsageChildChannel({ endpoint: childEndpoint, versionId: null, ...dispatcher })
  t.after(async () => {
    if (actual && actual.exitCode === null && actual.signalCode === null) actual.kill('SIGKILL')
    if (ended) await ended
    parent.reaped(); child?.close()
    if (!options.root) await rm(root, { recursive: true, force: true })
  })
  const initialize = async () => {
    await parent.control('initialize', { generation, mode: 'settings', restore: false, bootstrap: options.bootstrap ?? bootstrap }); await parent.ready
    await parent.control('initialize', { generation, mode: 'subscriptions' })
    await parent.control('initialize', { generation, mode: 'services' })
  }
  const request = async (method, params, actor = owner) => admission.withLease(async lease => {
    const token = authority.capture(method, actor)
    try { return await parent.request(method, params, { usageLease: lease, capturedAuthorization: token }) }
    finally { authority.release(token) }
  })
  return { root, parent, child, generation, initialize, request, effects, changes, admission, authority, projection, parentEndpoint, childEndpoint, ended, stderr: () => stderr }
}

test('shared endpoint and credit streams connect staged bootstrap, closed actor, settings errors and secret semantics', async t => {
  const f = await fixture(t); await f.initialize()
  assert.equal(f.projection.configuration('routing').enabled, false)
  const item = await f.request('secrets.create', { toolId: 'synthetic', label: '鍵', message: '入力' }, bot)
  const submitted = await f.request('secrets.submit', { id: item.id, value: 'private-IPC-value' })
  assert.equal(submitted.status, 'submitted'); assert.equal(submitted.notification, 'sent')
  assert.equal(await readFile(submitted.path, 'utf8'), 'private-IPC-value')
  assert.doesNotMatch(JSON.stringify([f.effects, f.changes]), /private-IPC-value/)
  await assert.rejects(f.request('secrets.submit', { id: item.id, value: 'retry' }), { code: 'SECRET_REQUEST_CLOSED', status: 409 })
  await assert.rejects(f.request('secrets.submit', { id: item.id, value: 'forbidden' }, bot), { code: 'USAGE_ACTOR_FORBIDDEN' })
  await f.request('settings.update', { id: 'routing', input: { enabled: false } })
  assert.equal(f.effects.find(item => item.method === 'settings.changed').params.epoch, 1)
  await f.parent.control('quiesce'); const exported = await f.parent.control('export')
  assert.equal(exported.handoff.schema, 'bellteam.usage-volatile.v1')
  await f.parent.control('exit')
})


test('restore keeps auth session, saved settings/error and stable projection without repeating effects', async t => {
  const f = await fixture(t, { effect: method => { if (method === 'settings.changed') throw Object.assign(new Error('not-public'), { code: 'SYNTHETIC_APPLY', status: 502 }) } })
  await f.initialize()
  await f.request('auth.start', { harness: 'codex' })
  await assert.rejects(f.request('settings.update', { id: 'routing', input: { enabled: true, values: { apiKey: 'private-routing' } } }), { code: 'FEATURE_APPLY_FAILED', status: 500 })
  await f.parent.control('quiesce'); const { handoff } = await f.parent.control('export'); await f.parent.control('exit')
  const g = await fixture(t, { root: f.root, generation: 'generation-b', projection: f.projection })
  await g.parent.control('initialize', { generation: g.generation, mode: 'restore', bootstrap, handoff })
  await g.parent.ready
  assert.equal(g.projection.configuration('routing').apiKey, 'private-routing')
  assert.equal(g.projection.list().find(item => item.id === 'routing').error.code, 'SYNTHETIC_APPLY')
  assert.deepEqual(g.effects.map(value => value.method), ['members.read'])
  const state = await g.request('auth.status', { harness: 'codex' })
  assert.equal(state.auth.session_id, 'auth-same')
  assert.equal(g.effects.at(-1).params.session_id, 'auth-same')
  await g.parent.control('quiesce'); await g.parent.control('exit')
})

test('an old live effect callback finishes through drain using the same lease and captured authority', async t => {
  const entered = deferred(), release = deferred(); let live
  const f = await fixture(t, { effect: (method, params, context) => {
    if (method === 'settings.changed') { live = context; entered.resolve(); return release.promise }
  } })
  await f.initialize()
  const update = f.request('settings.update', { id: 'routing', input: { enabled: false } })
  await entered.promise; const ticket = f.admission.close(), drain = f.parent.control('quiesce')
  const token = f.authority.capture('settings.setError', system)
  await f.parent.callback('settings.setError', { id: 'routing', epoch: 1, error: { code: 'CALLBACK_ERROR' } }, { usageLease: live.usageLease, usageEffect: live.usageEffect, capturedAuthorization: token })
  f.authority.release(token); release.resolve(null)
  assert.equal((await update).error.code, 'CALLBACK_ERROR'); assert.equal((await drain).quiesced, true)
  await f.admission.drain(ticket)
  const forged = f.authority.capture('settings.setError', system)
  await assert.rejects(f.parent.callback('settings.setError', { id: 'routing', epoch: 1, error: { code: 'FORGED' } }, { usageLease: live.usageLease, usageEffect: {}, capturedAuthorization: forged }))
  f.authority.release(forged); f.admission.resume(ticket)
  await f.parent.control('exit')
})

test('snapshot commit holds control completion after RPC metadata and disconnect until the reap barrier', async t => {
  const entered = deferred(), commit = deferred()
  const f = await fixture(t, { onSnapshotEnd: () => { entered.resolve(); return commit.promise } })
  const initialization = f.initialize(); initialization.catch(() => {})
  await entered.promise
  let settled = false; initialization.finally(() => { settled = true }).catch(() => {})
  assert.equal(f.parent.snapshot().control, 1)
  f.parentEndpoint.disconnect(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false); assert.equal(f.parent.snapshot().control, 1)
  f.parent.reaped(); await assert.rejects(initialization, { code: 'USAGE_CHILD_EXITED' })
  commit.resolve(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.projection.auth(), null)
})

test('eight accepted roots retain their real completions and the ninth is rejected before issue', async t => {
  const entered = deferred(), release = deferred()
  const f = await fixture(t, { effect: method => { if (method === 'settings.changed') { entered.resolve(); return release.promise } } }); await f.initialize()
  const lease = f.admission.enter(), token = f.authority.capture('settings.update', owner)
  const options = { usageLease: lease, capturedAuthorization: token }
  const calls = Array.from({ length: 8 }, () => f.parent.request('settings.update', { id: 'routing', input: { enabled: false } }, options))
  await entered.promise
  assert.equal(f.parent.snapshot().root, 8)
  await assert.rejects(f.parent.request('settings.update', { id: 'routing', input: { enabled: false } }, options), { code: 'USAGE_IPC_CAPACITY', outcome: 'not_accepted' })
  release.resolve(null); await Promise.all(calls); f.authority.release(token); f.admission.finish(lease)
  assert.equal(f.parent.snapshot().root, 0)
  await f.parent.control('quiesce'); await f.parent.control('exit')
})

test('private snapshot larger than one RPC payload streams each card with credit and no aggregate limit', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.initialize(); await f.parent.control('quiesce'); const { handoff } = await f.parent.control('export'); await f.parent.control('exit')
  const count = 4800, question = 'q'.repeat(2000), options = Array.from({ length: 8 }, (_, n) => `${n}`.padEnd(195, 'x'))
  for (let start = 0; start < count; start += 64) await Promise.all(Array.from({ length: Math.min(64, count - start) }, (_, offset) => {
    const n = start + offset, id = `large-${n}`
    return writeFile(join(f.root, 'state/owner-questions', `${id}.json`), JSON.stringify({ id, botId: 'bot-a', question, options, allowOther: true, at: '2026-11-03T00:00:00Z', status: 'open' }))
  }))
  let bytes = 0
  const g = await fixture(t, { root: f.root, generation: 'generation-large', onProjection: (row, context) => { if (context.phase === 'snapshot') bytes += Buffer.byteLength(JSON.stringify(row)) } })
  await g.parent.control('initialize', { generation: g.generation, mode: 'restore', bootstrap, handoff }, 25000)
  assert.ok(bytes > MODULE_PAYLOAD_LIMIT)
  assert.equal(g.projection.get('question', `large-${count - 1}`).question, question)
  assert.equal(g.parent.snapshot().streams.unconsumedBytes, 0)
  await g.parent.control('quiesce'); await g.parent.control('exit')
})

test('real advanced Node IPC uses the same dispatcher and exits after export/resume/close', async t => {
  const f = await fixture(t, { process: true }); await f.initialize()
  const item = await f.request('secrets.create', { toolId: 'synthetic', label: '鍵', message: '入力' }, bot)
  const value = await f.request('secrets.submit', { id: item.id, value: 'real-node-ipc-only' })
  assert.equal(value.notification, 'sent'); assert.equal(f.projection.get('secret', item.id).status, 'submitted')
  await f.parent.control('quiesce'); const { handoff } = await f.parent.control('export')
  assert.ok(handoff.epochs.length === 6)
  await f.parent.control('resume'); await f.parent.control('quiesce'); await f.parent.control('exit')
  assert.deepEqual(await f.ended, { code: 0, signal: null }); assert.equal(f.stderr(), '')
})


test('private initialize body exceeding control size stays streamed and the public settings reply hides its key', async t => {
  const secret = 'synthetic-private-bootstrap-'.repeat(5000)
  const f = await fixture(t, { bootstrap: { ...bootstrap, environment: { TYPESAFE_API_KEY: secret } } })
  await f.initialize()
  const list = await f.request('settings.list', {}, bot)
  assert.equal(list.find(item => item.id === 'routing').fields[0].value, '')
  assert.equal(f.projection.configuration('routing').apiKey, secret)
  assert.doesNotMatch(JSON.stringify(list), /synthetic-private-bootstrap/)
  const lease = f.admission.enter()
  await assert.rejects(f.parent.request('secrets.submit', { id: 'synthetic', value: secret }, { usageLease: lease, capturedAuthorization: { kind: 'owner', botId: null } }), { code: 'USAGE_ACTOR_FORBIDDEN' })
  f.admission.finish(lease)
  await f.parent.control('quiesce'); await f.parent.control('exit')
})


test('native auth not-issued survives sanitized IPC errors without exposing the response value', async t => {
  const binding = { session_id: 'auth-same', launch_id: 'launch', metadata_identity: 'identity', native_id: 'native', pane_id: 'pane', server_pid: 1, server_started: 'start', pane_pid: 2, pane_started: 'start' }
  const prompt = 'a'.repeat(64)
  const f = await fixture(t, { effect: (method, params) => {
    if (method !== 'auth.call') return
    if (params.action === 'respond') return { isError: true, structuredContent: { schema: 'aiterm.auth-response-error.v1', session_id: 'auth-same', effect: 'not_issued', code: 'SYNTHETIC_NOT_ISSUED' } }
    return { structuredContent: { schema: 'aiterm.agent-auth-result.v1', status: 'waiting', session_id: 'auth-same', auth_ui: {
      schema: 'aiterm.auth-ui.v1', binding, stage: 'paste_code', title: '認証', message: '', url: 'https://example.com/auth', user_code: null, input: 'authorization_code', prompt_digest: prompt, choices: [],
    } } }
  } })
  await f.initialize(); await f.request('auth.start', { harness: 'codex' })
  await assert.rejects(f.request('auth.input', { harness: 'codex', input: { binding, prompt_digest: prompt, response: { kind: 'authorization_code', value: 'private-native-input' } } }), { code: 'AUTH_RESPONSE_NOT_ISSUED', status: 409, effect: 'not_issued' })
  assert.doesNotMatch(JSON.stringify(f.changes), /private-native-input/)
  await f.parent.control('quiesce'); await f.parent.control('exit')
})
