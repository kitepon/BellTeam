import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createApplicationFeatures } from '../src/usage/application-features.mjs'
import { usageResultValid } from '../src/usage/process-results.mjs'
import { createUsageServices } from '../src/usage/services.mjs'
import { createUsageAuthority } from '../src/usage/authority.mjs'
import { createUsageProjection } from '../src/usage/projection.mjs'
import { createUsageRegistryPorts } from '../src/usage/registry-ports.mjs'
import { createUsageFacade } from '../src/usage/facade.mjs'

const owner = { kind: 'owner', botId: null }, system = { kind: 'system', botId: null }
const bot = { kind: 'bot', botId: 'bot-a' }, other = { kind: 'bot', botId: 'bot-b' }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
async function fixture(t, handler = () => undefined) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-usage-process-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bots = new Map([['bot-a', { id: 'bot-a', name: 'A', harness: 'codex', project: '/synthetic-parent-only' }], ['bot-b', { id: 'bot-b', name: 'B' }]])
  const effects = [], rows = []
  const options = { root, bots, rooms: new Map(), effect: async (method, params) => {
    effects.push({ method, params })
    return handler(method, params)
  }, onProjection: row => rows.push(row) }
  const service = createUsageServices(options)
  await service.initializeSettings(); await service.initialize()
  return { root, bots, options, service, effects, rows }
}
const error = code => Object.assign(new Error(code), { code })
const authResult = { structuredContent: { schema: 'aiterm.agent-auth-result.v1', status: 'waiting', session_id: 'auth-session', input_required: false } }

async function contents(root) {
  const result = []
  for (const item of await readdir(root, { recursive: true, withFileTypes: true })) if (item.isFile()) {
    const path = join(item.parentPath, item.name)
    result.push([path.slice(root.length), await readFile(path, 'utf8'), (await stat(path)).mode & 0o777])
  }
  return result.sort((a, b) => a[0].localeCompare(b[0]))
}

test('usage factory restores saved settings, sticky errors and native auth binding without replay', async t => {
  let applyFailure = true
  const f = await fixture(t, method => {
    if (method === 'settings.changed' && applyFailure) throw error('SYNTHETIC_APPLY_FAILED')
    if (method === 'auth.call') return authResult
  })
  await assert.rejects(f.service.request('settings.update', { id: 'routing', input: { enabled: true, values: { apiKey: 'synthetic-private-key' } } }, owner), { code: 'FEATURE_APPLY_FAILED' })
  await f.service.request('auth.start', { harness: 'codex' }, owner)
  assert.equal(f.effects.filter(row => row.method === 'auth.call').length, 1)
  assert.equal(Object.hasOwn(f.effects.find(row => row.method === 'auth.call').params, 'cwd'), false)
  assert.equal(await f.service.quiesce(), true)
  const handoff = f.service.exportState(), saved = await contents(f.root)
  f.service.close()
  const next = createUsageServices(f.options)
  await next.initializeSettings({ restore: true })
  const count = f.effects.length
  await next.initialize({ restore: true, handoff })
  assert.equal(f.effects.length, count)
  assert.deepEqual(await contents(f.root), saved)
  const configuration = await next.request('settings.configuration', { id: 'routing' }, system)
  assert.equal(configuration.apiKey, 'synthetic-private-key')
  const list = await next.request('settings.list', {}, bot)
  assert.equal(list.find(item => item.id === 'routing').error.code, 'SYNTHETIC_APPLY_FAILED')
  assert.doesNotMatch(JSON.stringify(list), /synthetic-private-key/)
  const auth = await next.request('auth.status', { harness: 'codex' }, owner)
  assert.equal(auth.auth.session_id, 'auth-session')
  assert.equal(f.effects.at(-1).params.session_id, 'auth-session')
  assert.equal(f.effects.filter(row => row.method === 'auth.call' && row.params.action === 'start').length, 1)
  applyFailure = false
  await next.request('settings.update', { id: 'routing', input: { enabled: false } }, owner)
  assert.equal((await next.request('settings.list', {}, bot)).find(item => item.id === 'routing').error, undefined)
})

test('quiesce waits for the actual secret callback and preserves value, failure and no reissue on restore', async t => {
  const waiting = deferred(), entered = deferred()
  const f = await fixture(t, method => { if (method === 'secret.completed') { entered.resolve(); return waiting.promise } })
  const item = await f.service.request('secrets.create', { toolId: 'synthetic', label: '鍵', message: '入力' }, bot)
  const submit = f.service.request('secrets.submit', { id: item.id, value: 'synthetic-submitted-value' }, owner)
  await entered.promise
  const draining = f.service.quiesce()
  await assert.rejects(f.service.request('secrets.get', { id: item.id }, owner), { code: 'USAGE_UNAVAILABLE' })
  assert.throws(() => f.service.exportState(), { code: 'USAGE_NOT_QUIESCED' })
  let drained = false; draining.then(() => { drained = true })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false)
  waiting.reject(error('SYNTHETIC_DELIVERY_FAILURE'))
  const submitted = await submit
  assert.equal(submitted.status, 'submitted'); assert.equal(submitted.notification, 'failed')
  assert.equal(await draining, true)
  assert.equal(await readFile(submitted.path, 'utf8'), 'synthetic-submitted-value')
  assert.equal((await stat(submitted.path)).mode & 0o777, 0o600)
  assert.doesNotMatch(JSON.stringify([submitted, f.rows, f.effects]), /synthetic-submitted-value/)
  const handoff = f.service.exportState(); f.service.close()
  const next = createUsageServices(f.options)
  await next.initializeSettings({ restore: true }); await next.initialize({ restore: true, handoff })
  assert.equal((await next.request('secrets.get', { id: item.id }, owner)).notification, 'failed')
  await assert.rejects(next.request('secrets.submit', { id: item.id, value: 'replace' }, owner), /SECRET_REQUEST_CLOSED/)
  assert.equal(f.effects.filter(row => row.method === 'secret.completed').length, 1)
  assert.equal(await readFile(submitted.path, 'utf8'), 'synthetic-submitted-value')
})

test('answered question survives callback failure; closed methods and actor ownership prevent privilege widening', async t => {
  const f = await fixture(t, method => { if (method === 'question.answered') throw error('SYNTHETIC_CALLBACK_FAILED') })
  const item = await f.service.request('questions.create', { question: '進める？', options: ['はい', '待つ'] }, bot)
  await assert.rejects(f.service.request('questions.answer', { id: item.id, input: { choice: 'はい' } }, owner), { code: 'SYNTHETIC_CALLBACK_FAILED' })
  assert.equal((await f.service.request('questions.get', { id: item.id }, owner)).status, 'answered')
  await assert.rejects(f.service.request('questions.get', { id: item.id }, other), { code: 'OWNER_QUESTION_NOT_FOUND' })
  await assert.rejects(f.service.request('secrets.submit', { id: item.id, value: 'forbidden' }, bot), { code: 'USAGE_ACTOR_FORBIDDEN' })
  await assert.rejects(f.service.request('questions.create', { botId: 'bot-b', question: 'x', options: ['a', 'b'] }, bot), { code: 'USAGE_INPUT_INVALID' })
  await assert.rejects(f.service.request('constructor', {}, owner), { code: 'USAGE_INPUT_INVALID' })
  await assert.rejects(f.service.request('settings.update', { id: 'routing', input: { values: { apiKey: 'raw' } } }, bot), { code: 'FEATURE_SECRET_VALUE_FORBIDDEN' })
  await assert.rejects(f.service.request('settings.update', { id: 'webPush', input: { enabled: false } }, bot), { code: 'USAGE_ACTOR_FORBIDDEN' })
  await assert.rejects(f.service.request('questions.answer', { id: item.id, input: { text: 'x', owner: true } }, owner), { code: 'USAGE_INPUT_INVALID' })
})

test('read-only startup rejects missing state and malformed handoff without importing environment or running effects', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-usage-readonly-')); t.after(() => rm(root, { recursive: true, force: true }))
  const missing = createUsageServices({ root, bots: new Map(), rooms: new Map(), effect: () => assert.fail('effect'), environment: { TYPESAFE_API_KEY: 'never-import' } })
  await assert.rejects(missing.initializeSettings({ restore: true }), { code: 'FEATURE_SETTINGS_MISSING' })
  assert.deepEqual(await readdir(root), [])
  const f = await fixture(t)
  assert.equal(await f.service.quiesce(), true)
  const handoff = f.service.exportState()
  const next = createUsageServices(f.options); await next.initializeSettings({ restore: true })
  const before = await contents(f.root)
  await assert.rejects(next.initialize({ restore: true, handoff: { ...handoff, sessions: [['codex', 'a'], ['codex', 'b']] } }), { code: 'USAGE_HANDOFF_INVALID' })
  assert.deepEqual(await contents(f.root), before)
})

test('quiesce canceled by resume cannot later authorize a handoff', async t => {
  const wait = deferred(), entered = deferred()
  const f = await fixture(t, method => { if (method === 'settings.changed') { entered.resolve(); return wait.promise } })
  const update = f.service.request('settings.update', { id: 'routing', input: { enabled: false } }, owner)
  await entered.promise
  const drain = f.service.quiesce(); f.service.resume(); wait.resolve()
  await update
  assert.equal(await drain, false)
  assert.throws(() => f.service.exportState(), { code: 'USAGE_NOT_QUIESCED' })
})

test('opaque authority is method-bound, parent-local, revocable and cannot be forged by body fields', () => {
  const a = createUsageAuthority(), b = createUsageAuthority()
  const token = a.capture('secrets.submit', owner)
  assert.deepEqual(a.authorizeActor('secrets.submit', token), owner)
  for (const [authority, method, input] of [[a, 'secrets.cancel', token], [b, 'secrets.submit', token], [a, 'secrets.submit', { kind: 'owner', botId: null }]]) {
    assert.throws(() => authority.authorizeActor(method, input), { code: 'USAGE_ACTOR_FORBIDDEN' })
  }
  a.release(token); assert.throws(() => a.authorizeActor('secrets.submit', token), { code: 'USAGE_ACTOR_FORBIDDEN' })
  assert.throws(() => a.capture('auth.start', bot), { code: 'USAGE_ACTOR_FORBIDDEN' })
})

test('private projection swaps atomically and facade keeps copies and fresh reads distinct', async t => {
  const f = await fixture(t)
  const item = await f.service.request('secrets.create', { toolId: 'synthetic', label: '鍵', message: '入力' }, bot)
  const projection = createUsageProjection({ bots: f.bots })
  projection.begin(1); for (const row of f.service.snapshot()) projection.accept(row, 1); projection.commit(1)
  const authority = createUsageAuthority()
  const facade = createUsageFacade({ projection, toolsDirectory: join(f.root, 'state/secret-values'), request: (method, params, token) => f.service.request(method, params, authority.authorizeActor(method, token)) })
  const saved = facade.settings.configuration('routing'); saved.apiKey = 'mutated'
  assert.equal(facade.settings.configuration('routing').apiKey, '')
  const card = facade.secretRequests.get(item.id); card.status = 'submitted'
  assert.equal(facade.secretRequests.get(item.id).status, 'pending')
  const token = authority.capture('secrets.get', bot)
  assert.equal((await facade.secretRequests.read(item.id, token)).id, item.id)
  assert.throws(() => facade.secretRequests.read(item.id, {}), { code: 'USAGE_ACTOR_FORBIDDEN' })
  projection.begin(2); projection.accept([...f.service.snapshot()][0], 2)
  assert.throws(() => projection.commit(2), { code: 'USAGE_PROJECTION_INCOMPLETE' })
  assert.equal(facade.secretRequests.get(item.id).id, item.id)
  projection.discard(2)
  assert.throws(() => projection.accept({ type: 'secret', value: { ...item, value: 'forbidden' }, revision: 999 }, 1), { code: 'USAGE_PROJECTION_INVALID' })
  assert.equal(facade.subscriptions.verify, undefined)
})


test('late setting errors require the saved feature epoch and cannot clear a newer failure', async t => {
  const f = await fixture(t)
  await f.service.request('settings.update', { id: 'routing', input: { enabled: false } }, owner)
  await f.service.request('settings.setError', { id: 'routing', epoch: 1, error: { code: 'LATEST_FAILURE' } }, system)
  await assert.rejects(f.service.request('settings.setError', { id: 'routing', epoch: 0, error: { code: 'OLD_FAILURE' } }, system), { code: 'USAGE_SETTINGS_STALE' })
  await assert.rejects(f.service.request('settings.setError', { id: 'routing', epoch: 1, error: null }, system), { code: 'USAGE_INPUT_INVALID' })
  assert.equal((await f.service.request('settings.list', {}, owner)).find(item => item.id === 'routing').error.code, 'LATEST_FAILURE')
  const row = [...f.service.snapshot()].find(row => row.type === 'settings')
  assert.equal(row.epochs.routing, 1)
  const projection = createUsageProjection({ bots: f.bots }); projection.begin(1)
  assert.throws(() => projection.accept({ ...row, list: row.list.map(item => ({ ...item, fields: item.fields.map(field => ({ ...field, value: field.secret ? 'bad' : field.value })) })) }, 1), { code: 'USAGE_PROJECTION_INVALID' })
})

test('child registry ports allow only metadata and the fixed guide creation effect', async () => {
  const seen = [], guide = { id: 'bot-guide', name: '案内', harness: 'codex' }
  const ports = createUsageRegistryPorts({ initialMembers: [], effect: async (method, params) => {
    seen.push({ method, params })
    if (method === 'onboarding.ensureGuide') return guide
    if (method === 'members.read') return [guide]
    if (method === 'rooms.read') return [{ id: 'room-a', memberIds: ['bot-guide'] }]
  } })
  await ports.bots.refresh(); assert.equal(ports.bots.size, 1)
  await ports.bots.update('bot-guide', { harness: 'codex' })
  await ports.rooms.refresh(); assert.equal(ports.rooms.get('room-a').memberIds[0], 'bot-guide')
  const item = ports.bots.get('bot-guide'); item.name = 'changed'; assert.equal(ports.bots.get('bot-guide').name, '案内')
  assert.throws(() => ports.bots.update('another', { harness: 'codex' }), { code: 'USAGE_EFFECT_INVALID' })
  assert.throws(() => createUsageRegistryPorts({ initialMembers: [{ ...guide, project: '/forbidden' }], effect: () => {} }), { code: 'USAGE_MEMBERS_INVALID' })
  assert.equal(seen.some(row => JSON.stringify(row).includes('/forbidden')), false)
})

test('a created card retains its parent callback until real completion even though the legacy callback is synchronous', async t => {
  const entered = deferred(), done = deferred()
  const f = await fixture(t, method => { if (method === 'question.created') { entered.resolve(); return done.promise } })
  let settled = false
  const create = f.service.request('questions.create', { question: '続けますか', options: ['はい', '待つ'] }, bot).then(item => { settled = true; return item })
  await entered.promise
  const drain = f.service.quiesce()
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false)
  done.resolve(); const item = await create
  assert.equal(item.status, 'open'); assert.equal(await drain, true)
})


test('live apply-error callback remains admitted during drain and is refused after the root finishes', async t => {
  const entered = deferred(), done = deferred()
  const f = await fixture(t, method => { if (method === 'settings.changed') { entered.resolve(); return done.promise } })
  const update = f.service.request('settings.update', { id: 'routing', input: { enabled: false } }, owner)
  await entered.promise
  const drain = f.service.quiesce()
  await f.service.callback('settings.setError', { id: 'routing', epoch: 1, error: { code: 'LATE_APPLY_FAILURE' } }, system)
  done.resolve(); const result = await update
  assert.equal(result.error.code, 'LATE_APPLY_FAILURE')
  assert.equal(await drain, true)
  await assert.rejects(f.service.callback('settings.setError', { id: 'routing', epoch: 1, error: { code: 'NO_LIVE_ROOT' } }, system), { code: 'USAGE_CALLBACK_UNAVAILABLE' })
  assert.deepEqual(f.service.exportState().errors, [['routing', 'LATE_APPLY_FAILURE']])
})

test('the same parent facade survives usage exchange and return with writer state and authority kept separate', async t => {
  const f = await fixture(t)
  let current = f.service, generation = 0
  const projection = createUsageProjection({ bots: f.bots }), authority = createUsageAuthority()
  const facade = createUsageFacade({ projection, toolsDirectory: join(f.root, 'state/secret-values'), request: (method, params, token) => current.request(method, params, authority.authorizeActor(method, token)) })
  const adopt = () => { generation++; projection.begin(generation); for (const row of current.snapshot()) projection.accept(row, generation); projection.commit(generation) }
  adopt()
  const stableSettings = facade.settings, stableSecrets = facade.secretRequests
  const createToken = authority.capture('secrets.create', bot)
  const item = await stableSecrets.create({ botId: 'ignored-untrusted', toolId: 'synthetic', label: '鍵', message: '入力' }, createToken)
  authority.release(createToken)
  const submitToken = authority.capture('secrets.submit', owner)
  const submitted = await stableSecrets.submit(item.id, 'synthetic-keep-through-ABA', submitToken)
  authority.release(submitToken)
  for (let step = 0; step < 2; step++) {
    await current.quiesce(); const handoff = current.exportState(); current.close()
    current = createUsageServices(f.options)
    await current.initializeSettings({ restore: true }); await current.initializeSubscriptions({ restore: true })
    await current.initialize({ restore: true, handoff }); adopt()
    assert.equal(facade.settings, stableSettings); assert.equal(facade.secretRequests, stableSecrets)
    assert.equal(stableSecrets.get(item.id).status, 'submitted')
    assert.equal(await readFile(submitted.path, 'utf8'), 'synthetic-keep-through-ABA')
  }
  assert.equal(f.effects.filter(row => row.method === 'secret.completed').length, 1)
  assert.throws(() => stableSecrets.submit(item.id, 'no', createToken), { code: 'USAGE_ACTOR_FORBIDDEN' })
})


test('settings and subscriptions can seed the real bootstrap order before members and cards exist', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-usage-bootstrap-')); t.after(() => rm(root, { recursive: true, force: true }))
  const bots = new Map([['bot-a', { id: 'bot-a', name: 'A' }]])
  const projection = createUsageProjection({ bots })
  const service = createUsageServices({ root, bots, rooms: new Map(), effect: () => assert.fail('bootstrap effect'), onProjection: row => projection.accept(row, 0) })
  projection.seed(await service.initializeSettings(), 0)
  assert.equal(projection.configuration('callBridge').enabled, false)
  projection.seed(await service.initializeSubscriptions(), 0)
  assert.equal(projection.subscription().canUseAI, true)
  await service.request('settings.setError', { id: 'notifications', epoch: 0, error: { code: 'INITIAL_APPLY_FAILURE' } }, system)
  await assert.rejects(service.request('settings.update', { id: 'routing', input: { enabled: false } }, owner), { code: 'USAGE_UNAVAILABLE' })
  await service.initialize()
  projection.begin(0); for (const row of service.snapshot()) projection.accept(row, 0); projection.commit(0)
  assert.equal(projection.list().find(item => item.id === 'notifications').error.code, 'INITIAL_APPLY_FAILURE')
})


test('the real settings apply caller waits for configuration completion and reports the captured feature epoch', async t => {
  const entered = deferred(), done = deferred()
  let settings
  const f = await fixture(t, (method, params) => method === 'settings.changed' ? settings.onChange(params.id, params.configuration, { epoch: params.epoch }) : undefined)
  const authority = createUsageAuthority(), projection = createUsageProjection({ bots: f.bots })
  projection.begin(0); for (const row of f.service.snapshot()) projection.accept(row, 0); projection.commit(0)
  const facade = createUsageFacade({ projection, request: (method, params, token) => f.service.request(method, params, authority.authorizeActor(method, token)) })
  settings = facade.settings
  const failures = []
  const features = createApplicationFeatures({ services: { bots: f.bots, settings, messenger: {}, diagnostics: { record: async row => failures.push(row) },
    notifications: { initialStatus: async () => ({}) }, transport: { isRunning: async () => true, stopForConfiguration: async () => { entered.resolve(); await done.promise } } },
    home: '/unused', environment: {}, notify: () => {}, configureHarnessConfig: async () => {}, usageContext: method => authority.capture(method, system) })
  await features.initialize()
  let finished = false
  const update = f.service.request('settings.update', { id: 'callBridge', input: { enabled: false } }, owner).then(value => { finished = true; return value })
  await entered.promise
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false)
  done.reject(error('SYNTHETIC_CONFIGURATION_FAILED'))
  const result = await update
  assert.equal(result.error.code, 'SYNTHETIC_CONFIGURATION_FAILED')
  assert.ok(failures.some(row => row.code === 'SERVER_CALL_CONFIGURATION_FAILED'))
  assert.equal(f.effects.find(row => row.method === 'settings.changed').params.epoch, 1)
  await features.close()
})


test('private projection ACK precedes parent effects and replies; publication failure keeps saved state and closes admission', async t => {
  const entered = deferred(), ack = deferred(), parent = []
  const f = await fixture(t)
  const service = createUsageServices({ ...f.options, effect: (method, params) => { parent.push(method) }, onProjection: async row => { entered.resolve(); await ack.promise } })
  await service.initializeSettings({ restore: true }); await service.initialize({ restore: true })
  let settled = false
  const update = service.request('settings.update', { id: 'routing', input: { enabled: false } }, owner).then(value => { settled = true; return value })
  await entered.promise
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false); assert.deepEqual(parent, [])
  ack.resolve(); await update; assert.deepEqual(parent, ['settings.changed'])
  const broken = createUsageServices({ ...f.options, onProjection: () => { throw error('PRIVATE_CHANNEL_LOST') } })
  await broken.initializeSettings({ restore: true }); await broken.initialize({ restore: true })
  await assert.rejects(broken.request('settings.update', { id: 'routing', input: { enabled: false, values: { apiKey: 'saved-before-ack-failure' } } }, owner), { code: 'USAGE_PROJECTION_UNAVAILABLE' })
  assert.equal(JSON.parse(await readFile(join(f.root, 'shared/tools/bellteam-settings/settings.json'), 'utf8')).routing.apiKey, 'saved-before-ack-failure')
  await assert.rejects(broken.request('settings.list', {}, owner), { code: 'USAGE_PROJECTION_UNAVAILABLE' })
})


test('reply validators reject leaked values and foreign IDs before public success', async t => {
  const f = await fixture(t)
  const item = await f.service.request('secrets.create', { toolId: 'synthetic', label: '鍵', message: '入力' }, bot)
  assert.equal(usageResultValid('secrets.get', item, { id: item.id }), true)
  assert.equal(usageResultValid('secrets.get', { ...item, value: 'forbidden' }, { id: item.id }), false)
  assert.equal(usageResultValid('secrets.get', item, { id: 'different' }), false)
  const list = await f.service.request('settings.list', {}, owner)
  assert.equal(usageResultValid('settings.list', list), true)
  list[0].fields[0].value = 'forbidden'
  assert.equal(usageResultValid('settings.list', list), false)
  assert.equal(usageResultValid('settings.setError', {}), false)
  assert.equal(usageResultValid('unrecognized', null), false)
})


test('initial onboarding auth keeps nullable fields across the actual JSON IPC representation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-usage-onboarding-')); t.after(() => rm(root, { recursive: true, force: true }))
  const effect = async (method, params) => {
    if (method === 'members.read') return []
    if (method === 'onboarding.ensureGuide') return { id: 'bot-guide', name: '案内', harness: 'codex' }
    if (method === 'auth.call') return authResult
  }
  const ports = createUsageRegistryPorts({ effect, initialMembers: [] })
  const service = createUsageServices({ root, ...ports, effect })
  await service.initializeSettings(); await service.initialize()
  const value = JSON.parse(JSON.stringify(await service.request('onboarding.select', { harness: 'codex' }, owner)))
  assert.equal(value.auth.url, null); assert.equal(value.auth.user_code, null); assert.equal(value.auth.message, null)
  assert.equal(value.auth.input_required, false)
  assert.equal(usageResultValid('onboarding.select', value), true)
})
