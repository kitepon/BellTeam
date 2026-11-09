import assert from 'node:assert/strict'
import { once, EventEmitter } from 'node:events'
import { deserialize, serialize } from 'node:v8'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BackgroundAgentSettings, backgroundRecordValid } from '../src/usage/background-agent-settings.mjs'
import { createUsageServices } from '../src/usage/services.mjs'
import { createUsageProjection } from '../src/usage/projection.mjs'
import { createUsageFacade } from '../src/usage/facade.mjs'
import { createUsageApi } from '../src/usage/http-api.mjs'
import { respondHttpError } from '../src/http-errors.mjs'
import { usageEffectValid, usageEffectResultValid } from '../src/usage/channel-protocol.mjs'
import { createUsageParentChannel, createUsageChildChannel } from '../src/usage/channel.mjs'
import { createUsageChannelDispatcher } from '../src/usage/channel-dispatcher.mjs'
import { createUsageAuthority } from '../src/usage/authority.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'
import { usageResultValid } from '../src/usage/process-results.mjs'

const owner = { kind: 'owner', botId: null }, bot = { kind: 'bot', botId: 'bot-a' }
const models = [{ id: 'synthetic-high-only', efforts: ['high'] }, { id: 'synthetic-no-effort', efforts: [] }]
const initial = { expectedRevision: null, harness: 'codex', model: models[0].id, reasoningEffort: 'high' }
async function rootFor(t) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-background-settings-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('background settings save once, retain existing settings bytes and restore without effects', async t => {
  const root = await rootFor(t), calls = []
  const service = new BackgroundAgentSettings({ root, models: async () => models, onChange: value => calls.push(value) })
  await service.initialize()
  assert.deepEqual(service.configuration(), { revision: null, selection: null })
  await assert.rejects(readFile(service.path), { code: 'ENOENT' })
  const saved = await service.update(initial)
  assert.ok(backgroundRecordValid(saved)); assert.equal(calls.length, 1)
  assert.equal((await stat(service.path)).mode & 0o777, 0o600)
  const bytes = await readFile(service.path, 'utf8')
  assert.deepEqual(await service.update({ ...initial, expectedRevision: saved.revision }), saved)
  assert.equal(calls.length, 1); assert.equal(await readFile(service.path, 'utf8'), bytes)
  const restored = new BackgroundAgentSettings({ root, models: () => assert.fail('restore requested models'), onChange: () => assert.fail('restore applied settings') })
  await restored.initialize(); assert.deepEqual(restored.configuration(), saved)
})

test('individual model efforts, missing model, unavailable catalog and stale revisions save nothing', async t => {
  const root = await rootFor(t)
  let catalog = models
  const service = new BackgroundAgentSettings({ root, models: async () => catalog })
  await service.initialize()
  for (const [input, code] of [
    [{ ...initial, reasoningEffort: 'low' }, 'BACKGROUND_AGENT_EFFORT_INVALID'],
    [{ ...initial, model: 'unknown' }, 'BACKGROUND_AGENT_MODEL_INVALID'],
    [{ ...initial, harness: 'codex-cli' }, 'BACKGROUND_AGENT_HARNESS_INVALID'],
    [{ ...initial, extra: true }, 'BACKGROUND_AGENT_INPUT_INVALID'],
  ]) await assert.rejects(service.update(input), { code, status: 400 })
  catalog = []; await assert.rejects(service.update(initial), { code: 'BACKGROUND_AGENT_MODELS_UNAVAILABLE', status: 503 })
  await assert.rejects(readFile(service.path), { code: 'ENOENT' })
  catalog = models
  const saved = await service.update(initial)
  const concurrent = await Promise.allSettled([
    service.update({ ...initial, expectedRevision: saved.revision, model: 'synthetic-no-effort', reasoningEffort: '' }),
    service.update({ ...initial, expectedRevision: saved.revision, model: 'synthetic-no-effort', reasoningEffort: '' }),
  ])
  assert.equal(concurrent[0].status, 'fulfilled'); assert.equal(concurrent[1].reason.code, 'BACKGROUND_AGENT_REVISION_CONFLICT')
  assert.notEqual(service.configuration().revision, saved.revision)
  const noEffort = service.configuration()
  const back = await service.update({ ...initial, expectedRevision: noEffort.revision })
  assert.notEqual(back.revision, saved.revision)
})

test('apply failure preserves saved revision, storage failure preserves prior record, corrupt state is not reset', async t => {
  const root = await rootFor(t)
  const service = new BackgroundAgentSettings({ root, models: async () => models, onChange: () => { throw new Error('private native detail') } })
  await service.initialize()
  await assert.rejects(service.update(initial), { code: 'BACKGROUND_AGENT_APPLY_FAILED', status: 500 })
  const saved = service.configuration()
  assert.equal(JSON.parse(await readFile(service.path, 'utf8')).revision, saved.revision)
  const originalPath = service.path
  service.path = join(root, 'directory-target'); await mkdir(service.path)
  await assert.rejects(service.update({ ...initial, expectedRevision: saved.revision, model: 'synthetic-no-effort', reasoningEffort: '' }), { code: 'BACKGROUND_AGENT_STATE_FAILED' })
  assert.deepEqual(service.configuration(), saved)
  await writeFile(originalPath, '{corrupt')
  const restored = new BackgroundAgentSettings({ root, models: async () => models })
  await restored.initialize()
  assert.throws(() => restored.configuration(), { code: 'BACKGROUND_AGENT_STATE_INVALID' })
  await assert.rejects(restored.update(initial), { code: 'BACKGROUND_AGENT_STATE_INVALID' })
  assert.equal(await readFile(originalPath, 'utf8'), '{corrupt')
})

async function connected(t) {
  const root = await rootFor(t), bots = new Map(), projection = createUsageProjection({ bots })
  const effects = []; let active = false, failApply = false
  const service = createUsageServices({ root, bots, rooms: new Map(), environment: {},
    onProjection: row => { if (active) projection.accept(row, 'new-generation') },
    effect: async (method, params) => {
      effects.push({ method, params })
      if (method === 'backgroundAgent.models') return models
      if (method === 'backgroundAgent.changed') {
        assert.deepEqual(projection.backgroundAgent(), params.configuration)
        if (failApply) throw new Error('private apply failure')
      }
      return null
    } })
  projection.seed(await service.initializeSettings(), 'new-generation')
  await service.initialize(); projection.begin('new-generation')
  for (const row of service.snapshot()) projection.accept(row, 'new-generation')
  projection.commit('new-generation'); active = true
  const facade = createUsageFacade({ projection, request: (method, params, actor) => service.request(method, params, actor) })
  t.after(async () => { await service.quiesce(); service.close() })
  return { root, service, facade, effects, projection, failApply: () => { failApply = true } }
}

test('usage writer publishes the same record before apply, preserves the seven settings and restricts Owner writes', async t => {
  const f = await connected(t)
  const prior = await readFile(join(f.root, 'shared/tools/bellteam-settings/settings.json'), 'utf8')
  const saved = await f.facade.settings.updateBackgroundAgent(initial, { usageContext: owner })
  assert.deepEqual(await f.facade.settings.backgroundAgentConfiguration(), saved)
  assert.deepEqual(f.effects.map(row => row.method), ['backgroundAgent.models', 'backgroundAgent.changed'])
  assert.equal(f.facade.settings.list().length, 7)
  assert.equal(await readFile(join(f.root, 'shared/tools/bellteam-settings/settings.json'), 'utf8'), prior)
  await assert.rejects(f.facade.settings.updateBackgroundAgent({ ...initial, expectedRevision: saved.revision }, { usageContext: bot }), { code: 'USAGE_ACTOR_FORBIDDEN', status: 403 })
  f.failApply()
  await assert.rejects(f.facade.settings.updateBackgroundAgent({ ...initial, expectedRevision: saved.revision, model: 'synthetic-no-effort', reasoningEffort: '' }, { usageContext: owner }), { code: 'BACKGROUND_AGENT_APPLY_FAILED' })
  assert.equal((await f.facade.settings.backgroundAgentConfiguration()).selection.model, 'synthetic-no-effort')
})

test('closed parent effects bind harness and saved selection to the authenticated update', () => {
  const context = { generation: 'g', rootId: '1', kind: 'root', method: 'settings.updateBackgroundAgent', mode: null, actor: owner, continuation: false }
  assert.equal(usageEffectValid('backgroundAgent.models', { harness: 'codex' }, context, initial), true)
  assert.equal(usageEffectValid('backgroundAgent.models', { harness: 'claude' }, context, initial), false)
  assert.equal(usageEffectValid('backgroundAgent.models', { harness: 'codex', path: '/private' }, context, initial), false)
  assert.equal(usageEffectResultValid('backgroundAgent.models', models), true)
  assert.equal(usageEffectResultValid('backgroundAgent.models', [{ ...models[0], private: 'value' }]), false)
  const configuration = { revision: '11111111-1111-4111-8111-111111111111', selection: { harness: initial.harness, model: initial.model, reasoningEffort: initial.reasoningEffort } }
  assert.equal(usageEffectValid('backgroundAgent.changed', { configuration }, context, initial), true)
  assert.equal(usageEffectValid('backgroundAgent.changed', { configuration: { ...configuration, selection: { ...configuration.selection, model: 'other' } } }, context, initial), false)
  assert.equal(usageResultValid('settings.updateBackgroundAgent', configuration, initial), true)
  assert.equal(usageResultValid('settings.updateBackgroundAgent', { ...configuration, selection: { ...configuration.selection, model: 'other' } }, initial), false)
})

test('public HTTP returns the fixed record, rejects extra input and reloads saved state after apply failure', async t => {
  const f = await connected(t)
  const api = createUsageApi({ settings: f.facade.settings, captureUsageContext: () => owner })
  const server = createServer(async (request, response) => {
    try { await api(request, response, new URL(request.url, 'http://localhost')) }
    catch (error) { await respondHttpError(request, response, error) }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const get = () => fetch(base + '/api/settings').then(r => r.json())
  const patch = input => fetch(base + '/api/settings/backgroundAgent', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  assert.deepEqual((await get()).backgroundAgent, { revision: null, selection: null })
  assert.equal((await patch({ ...initial, extra: true })).status, 400)
  const first = await patch(initial); assert.equal(first.status, 200)
  const { backgroundAgent: saved } = await first.json()
  const conflict = await patch(initial); assert.equal(conflict.status, 409)
  assert.equal((await conflict.json()).error, 'BACKGROUND_AGENT_REVISION_CONFLICT')
  f.failApply()
  const failed = await patch({ ...initial, expectedRevision: saved.revision, model: 'synthetic-no-effort', reasoningEffort: '' })
  assert.equal(failed.status, 500); assert.equal((await failed.json()).error, 'BACKGROUND_AGENT_APPLY_FAILED')
  assert.equal((await get()).backgroundAgent.selection.model, 'synthetic-no-effort')
})

test('new closed methods cross the real usage channel with the same generation record', async t => {
  const root = await rootFor(t), parentEndpoint = new EventEmitter(), childEndpoint = new EventEmitter()
  for (const [from, to] of [[parentEndpoint, childEndpoint], [childEndpoint, parentEndpoint]]) {
    from.connected = true
    from.send = (value, callback) => { const frame = deserialize(serialize(value)); queueMicrotask(() => { if (to.connected) to.emit('message', frame); callback?.() }) }
    from.disconnect = () => { if (!from.connected) return; from.connected = false; to.connected = false; from.emit('disconnect'); to.emit('disconnect') }
  }
  const generation = 'background-new', admission = new MembersAdmission(generation), authority = createUsageAuthority()
  const projection = createUsageProjection({ bots: new Map() }), effects = []
  let child
  const parent = createUsageParentChannel(parentEndpoint, { generation, admission, authorizeActor: authority.authorizeActor,
    onProjection: (row, context) => context.phase === 'seed' ? projection.seed(row, generation) : projection.accept(row, generation),
    onSnapshotStart: () => projection.begin(generation), onSnapshotEnd: () => projection.commit(generation), onSnapshotAbort: () => projection.discard(generation),
    onEffect: async (method, params) => {
      effects.push({ method, params })
      if (method === 'backgroundAgent.models') return models
      if (method === 'members.read') return []
      if (method === 'backgroundAgent.changed') assert.deepEqual(projection.backgroundAgent(), params.configuration)
      return null
    } })
  const dispatcher = createUsageChannelDispatcher({ root, effect: (...args) => child.effect(...args), projection: (...args) => child.projection(...args) })
  child = createUsageChildChannel({ endpoint: childEndpoint, versionId: null, ...dispatcher })
  t.after(() => { parent.reaped(); child.close() })
  await parent.control('initialize', { generation, mode: 'settings', restore: false, bootstrap: { environment: {}, seatRuntime: false, subscription: {} } })
  await parent.ready
  await parent.control('initialize', { generation, mode: 'subscriptions' })
  await parent.control('initialize', { generation, mode: 'services' })
  const request = (method, params) => admission.withLease(async lease => {
    const token = authority.capture(method, owner)
    try { return await parent.request(method, params, { usageLease: lease, capturedAuthorization: token }) }
    finally { authority.release(token) }
  })
  const saved = await request('settings.updateBackgroundAgent', initial)
  assert.deepEqual(await request('settings.backgroundAgent', {}), saved)
  await assert.rejects(request('settings.updateBackgroundAgent', initial), { code: 'BACKGROUND_AGENT_REVISION_CONFLICT', status: 409 })
  assert.equal(effects.filter(row => row.method === 'backgroundAgent.changed').length, 1)
  await parent.control('quiesce')
  await parent.control('exit')
})

test('corrupt background record does not stop other usage settings or initialize a replacement', async t => {
  const root = await rootFor(t), path = join(root, 'shared/tools/bellteam-settings/background-agent.json')
  await mkdir(join(root, 'shared/tools/bellteam-settings'), { recursive: true }); await writeFile(path, '{broken')
  const service = createUsageServices({ root, bots: new Map(), rooms: new Map(), environment: {}, effect: () => assert.fail('unexpected background effect') })
  const seed = await service.initializeSettings()
  assert.equal(seed.backgroundAgentError, 'BACKGROUND_AGENT_STATE_INVALID')
  await service.initialize()
  assert.equal((await service.request('settings.list', {}, owner)).length, 7)
  await assert.rejects(service.request('settings.backgroundAgent', {}, owner), { code: 'BACKGROUND_AGENT_STATE_INVALID' })
  assert.equal(await readFile(path, 'utf8'), '{broken')
  await service.quiesce(); service.close()
})
