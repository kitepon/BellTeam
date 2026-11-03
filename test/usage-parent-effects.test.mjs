import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUsageParentEffects } from '../src/usage-parent-effects.mjs'
import { createUsageServices } from '../src/usage/services.mjs'
import { createUsageRegistryPorts } from '../src/usage/registry-ports.mjs'
import { GUIDE_BOT_ID } from '../src/onboarding.mjs'

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const context = Object.freeze({ method: 'auth.start', usageLease: Object.freeze({}), usageEffect: Object.freeze({}) })
const owner = { kind: 'owner', botId: null }, system = { kind: 'system', botId: null }
function fixture() {
  const calls = [], options = { env: { SYNTHETIC_PARENT_ONLY: 'kept-private' } }
  const bots = new Map([['bot-a', { id: 'bot-a', name: 'A', harness: 'codex', project: '/untrusted-projection' }]])
  bots.refresh = async captured => { calls.push(['refresh', captured]) }
  bots.readMember = async (id, captured) => {
    calls.push(['readMember', id, captured])
    if (!bots.has(id)) throw Object.assign(new Error('BOT_NOT_FOUND'), { code: 'BOT_NOT_FOUND', status: 404 })
    return bots.get(id)
  }
  bots.projectPath = id => `/synthetic-parent/${id}`
  bots.create = async (input, captured) => { calls.push(['create', input, captured]); const bot = { ...input, id: captured.id }; bots.set(bot.id, bot); return bot }
  bots.update = async (id, changes, captured) => { calls.push(['update', id, changes, captured]); const bot = { ...bots.get(id), ...changes }; bots.set(id, bot); return bot }
  const rooms = new Map([['room-a', { id: 'room-a', memberIds: ['bot-a'], purpose: 'parent-only' }]])
  rooms.refresh = async captured => { calls.push(['rooms.refresh', captured]) }
  const transport = { isIdle: () => true, setupTest: async bot => { calls.push(['setupTest', bot]); return 'synthetic reply' }, client: {
    authOptions: () => options,
    call: async (...args) => { calls.push(['auth', ...args]); return { structuredContent: { schema: 'aiterm.agent-auth-result.v1', status: 'waiting', session_id: 'session-a', input_required: false }, content: [{ text: 'parent-only' }], env: options.env } },
  } }
  const services = { bots, rooms, transport,
    notifications: { secret: async item => calls.push(['secret', item]), question: async item => calls.push(['question', item]) },
    messenger: { enqueueUserTurn: async input => calls.push(['message', input]) },
  }
  let features = { onChange: async (...args) => calls.push(['apply', ...args]) }
  const seatRuntime = { membersProject: async (...args) => calls.push(['project', ...args]) }
  const effect = createUsageParentEffects({ getServices: () => services, getFeatures: () => features, seatRuntime })
  return { services, bots, calls, effect, options, seatRuntime, setFeatures: value => { features = value } }
}

test('all twelve parent effects use the same resources, closed metadata and fixed guide/native project', async () => {
  const f = fixture(), { effect, calls } = f
  assert.deepEqual(await effect('members.read', {}, context), [{ id: 'bot-a', name: 'A', harness: 'codex' }])
  assert.deepEqual(await effect('rooms.read', {}, context), [{ id: 'room-a', memberIds: ['bot-a'] }])
  const configuration = { enabled: false }
  assert.equal(await effect('settings.changed', { id: 'callBridge', configuration, epoch: 9 }, context), null)
  assert.deepEqual(calls.find(row => row[0] === 'apply'), ['apply', 'callBridge', configuration, { epoch: 9 }])
  const auth = await effect('auth.call', { harness: 'codex-cli', action: 'start', relogin: true }, context)
  assert.deepEqual(Object.keys(auth), ['structuredContent'])
  assert.doesNotMatch(JSON.stringify(auth), /parent-only|kept-private|untrusted-projection/)
  const native = calls.find(row => row[0] === 'auth')
  assert.deepEqual(native.slice(1), ['agent_auth', { harness: 'codex-cli', action: 'start', relogin: true, cwd: '/synthetic-parent/bot-a' }, f.options])
  const created = await effect('onboarding.ensureGuide', { harness: 'codex' }, context)
  assert.equal(created.id, GUIDE_BOT_ID)
  assert.deepEqual(Object.keys(created).sort(), ['harness', 'id', 'name'])
  const create = calls.find(row => row[0] === 'create')
  assert.equal(create[2].id, GUIDE_BOT_ID); assert.equal(create[2].usageLease, context.usageLease)
  await effect('onboarding.ensureGuide', { harness: 'claude' }, context)
  assert.deepEqual(calls.find(row => row[0] === 'update').slice(1), [GUIDE_BOT_ID, { harness: 'claude' }, context])
  await effect('onboarding.prepareStartup', { botId: GUIDE_BOT_ID, text: 'synthetic instructions' }, context)
  assert.deepEqual(calls.find(row => row[0] === 'project'), ['project', 'project.appendInstructions', { botId: GUIDE_BOT_ID, text: 'synthetic instructions' }])
  await effect('onboarding.startConversation', { botId: GUIDE_BOT_ID, message: 'guide' }, context)
  const item = { id: 'request-a', botId: 'bot-a' }
  await effect('secret.created', { item }, context); await effect('question.created', { item }, context)
  await effect('secret.completed', { botId: 'bot-a', message: 'saved' }, context)
  await effect('question.answered', { botId: 'bot-a', message: 'answered' }, context)
  assert.deepEqual(calls.filter(row => row[0] === 'message').map(row => row[1]), [
    { target: GUIDE_BOT_ID, message: 'guide', recordUser: false }, { target: 'bot-a', message: 'saved' }, { target: 'bot-a', message: 'answered' },
  ])
  assert.equal(calls.find(row => row[0] === 'secret')[1], item)
  assert.equal(calls.find(row => row[0] === 'question')[1], item)
  assert.equal(await effect('subscription.setupTest', { botId: 'bot-a' }, context), 'synthetic reply')
  assert.equal(calls.find(row => row[0] === 'setupTest')[1], f.bots.get('bot-a'))
  assert.ok(calls.filter(row => ['refresh', 'readMember', 'rooms.refresh'].includes(row[0])).every(row => row.at(-1) === context))
})

test('apply availability and actual completion remain visible, with original failure identity', async () => {
  const f = fixture()
  f.setFeatures(null)
  await assert.rejects(f.effect('settings.changed', { id: 'routing', configuration: {}, epoch: 0 }, context), { code: 'USAGE_EFFECT_UNAVAILABLE' })
  const terminal = deferred(), caller = Promise.resolve(null)
  Object.defineProperty(caller, 'completion', { value: terminal.promise })
  f.setFeatures({ onChange: () => caller })
  let finished = false
  const apply = f.effect('settings.changed', { id: 'routing', configuration: {}, epoch: 1 }, context).then(() => { finished = true })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false)
  terminal.resolve(); await apply; assert.equal(finished, true)
  const failure = Object.assign(new Error('synthetic'), { code: 'AUTH_RESPONSE_NOT_ISSUED', status: 502, effect: 'not_issued' })
  const release = deferred(), rejected = Promise.reject(failure); rejected.catch(() => {})
  Object.defineProperty(rejected, 'completion', { value: release.promise })
  f.services.transport.client.call = () => rejected
  let rejectedEarly = false
  const attempt = f.effect('auth.call', { harness: 'codex-cli', action: 'respond' }, context)
  attempt.catch(() => { rejectedEarly = true })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(rejectedEarly, false)
  release.reject(new Error('synthetic terminal failure')); await assert.rejects(attempt, error => error === failure)
})

test('native auth resolves fresh parent identity, rejects path injection and keeps status/error shapes', async () => {
  const f = fixture()
  f.bots.set(GUIDE_BOT_ID, { id: GUIDE_BOT_ID, name: 'Guide', harness: 'codex', project: '/old-projection' })
  await f.effect('auth.call', { harness: 'codex-cli', action: 'status' }, { ...context, method: 'onboarding.status' })
  assert.equal(f.calls.find(row => row[0] === 'auth')[2].cwd, `/synthetic-parent/${GUIDE_BOT_ID}`)
  f.calls.length = 0
  for (const field of ['cwd', 'env', 'actor', 'path']) await assert.rejects(f.effect('auth.call', { harness: 'codex-cli', action: 'start', [field]: '/outside' }, context), { code: 'USAGE_EFFECT_INVALID' })
  assert.equal(f.calls.length, 0)
  f.bots.clear()
  f.services.transport.client.call = async (...args) => { f.calls.push(['auth', ...args]); return { structuredContent: { schema: 'aiterm.auth-response-error.v1' }, isError: true, content: ['never-wire'] } }
  const value = await f.effect('auth.call', { harness: 'codex-cli', action: 'status' }, context)
  assert.equal(value.isError, true); assert.equal(Object.hasOwn(f.calls.at(-1)[2], 'cwd'), false)
  f.services.transport.client.call = async () => ({ content: ['invalid'] })
  await assert.rejects(f.effect('auth.call', { harness: 'codex-cli', action: 'status' }, context), { code: 'USAGE_EFFECT_RESULT_INVALID', status: 502 })
  await assert.rejects(f.effect('arbitrary.call', {}, context), { code: 'USAGE_EFFECT_UNSUPPORTED' })
})

test('setup native work is refused for missing/busy members and startup uses only the parent project', async t => {
  const f = fixture()
  await assert.rejects(f.effect('subscription.setupTest', { botId: 'missing' }, context), { code: 'BOT_NOT_FOUND', status: 404 })
  f.services.transport.isIdle = () => false
  await assert.rejects(f.effect('subscription.setupTest', { botId: 'bot-a' }, context), { code: 'SETUP_BOT_BUSY', status: 409 })
  assert.equal(f.calls.some(row => row[0] === 'setupTest'), false)
  const root = await mkdtemp(join(tmpdir(), 'bellteam-usage-parent-')); t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, GUIDE_BOT_ID); await mkdir(project); await writeFile(join(project, 'AGENTS.md'), 'existing')
  f.bots.set(GUIDE_BOT_ID, { id: GUIDE_BOT_ID, name: 'Guide', harness: 'codex', project: '/never-use-projection' })
  f.bots.projectPath = id => join(root, id)
  const direct = createUsageParentEffects({ getServices: () => f.services, getFeatures: () => null })
  await direct('onboarding.prepareStartup', { botId: GUIDE_BOT_ID, text: '\nappend' }, context)
  assert.equal(await readFile(join(project, 'AGENTS.md'), 'utf8'), 'existing\nappend')
  await assert.rejects(direct('onboarding.prepareStartup', { botId: '../outside', text: 'bad' }, context), { code: 'USAGE_EFFECT_INVALID' })
  const projectCalls = []
  const seated = createUsageParentEffects({ getServices: () => f.services, getFeatures: () => null,
    seatRuntime: { projectFiles: { appendInstructions: async (...args) => projectCalls.push(args) } } })
  await seated('onboarding.prepareStartup', { botId: GUIDE_BOT_ID, text: 'seat' }, context)
  assert.deepEqual(projectCalls, [[f.bots.get(GUIDE_BOT_ID), 'seat', context]])
})

test('real usage factory saves once and holds quiesce until the parent settings effect and error terminate', async t => {
  const f = fixture(), root = await mkdtemp(join(tmpdir(), 'bellteam-usage-parent-factory-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const entered = deferred(), release = deferred()
  const failure = Object.assign(new Error('synthetic apply'), { code: 'SYNTHETIC_APPLY_FAILED' })
  f.setFeatures({ onChange: async () => { entered.resolve(); await release.promise; throw failure } })
  const ports = createUsageRegistryPorts({ initialMembers: [], effect: (method, params) => f.effect(method, params, context) })
  await ports.bots.refresh()
  const service = createUsageServices({ root, ...ports, effect: (method, params) => f.effect(method, params, context) })
  await service.initializeSettings(); await service.initialize()
  const update = service.request('settings.update', { id: 'routing', input: { enabled: false, values: { apiKey: 'synthetic-saved' } } }, owner)
  const rejected = assert.rejects(update, { code: 'FEATURE_APPLY_FAILED' })
  await entered.promise
  assert.equal(JSON.parse(await readFile(join(root, 'shared/tools/bellteam-settings/settings.json'), 'utf8')).routing.apiKey, 'synthetic-saved')
  let drained = false
  const drain = service.quiesce().then(value => { drained = true; return value })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false)
  release.resolve(); await rejected; assert.equal(await drain, true)
  const state = service.exportState(); assert.equal(state.errors.find(([id]) => id === 'routing')[1], 'SYNTHETIC_APPLY_FAILED')
  service.resume()
  assert.equal((await service.request('settings.configuration', { id: 'routing' }, system)).apiKey, 'synthetic-saved')
  await service.quiesce(); service.close()
})
