import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createUsageApi } from '../src/usage/http-api.mjs'
import { createUsageFacade } from '../src/usage/facade.mjs'
import { createUsageServices } from '../src/usage/services.mjs'
import { createUsageParentEffects } from '../src/usage-parent-effects.mjs'
import { validateUsageRequest } from '../src/usage/process-schema.mjs'
import { usageResultValid } from '../src/usage/process-results.mjs'
import { usageEffectValid, usageEffectResultValid } from '../src/usage/channel-protocol.mjs'

const owner = { kind: 'owner', botId: null }
const context = { generation: 'synthetic-generation', rootId: '1', kind: 'root', method: 'auth.start', mode: null, actor: owner, continuation: false }
const auth = { status: 'waiting', url: null, user_code: null, input_required: false, message: null, session_id: 'synthetic-session', auth_ui: null }
const snapshot = { harness: 'claude', slot: '2nd', account_label: null, auth }
const binding = { session_id: 'second-session', launch_id: null, metadata_identity: 'synthetic:device', native_id: 'native-second', pane_id: '%2', server_pid: 100, server_started: '100-start', pane_pid: 101, pane_started: '101-start' }
const pasteCode = { schema: 'aiterm.auth-ui.v1', binding, stage: 'paste_code', title: 'Paste the code', message: 'Enter the displayed code.',
  url: 'https://claude.com/login', user_code: null, input: 'authorization_code', prompt_digest: 'a'.repeat(64), choices: [] }

async function call(api, path, input, method = 'POST') {
  const request = Readable.from([Buffer.from(JSON.stringify(input ?? {}))])
  request.method = method; request.headers = { 'content-type': 'application/json' }
  let result
  const response = { writeHead(status) { result = { status } }, end(body) { result.body = JSON.parse(body) } }
  await api(request, response, new URL(path, 'https://box.example.invalid'))
  return result
}

test('slot query traverses the existing HTTP/facade context contact and leaves bound input unchanged', async () => {
  const calls = [], tokens = []
  const facade = createUsageFacade({ request: async (method, params, captured) => {
    validateUsageRequest(method, params, owner)
    calls.push({ method, params, captured }); return snapshot
  }, projection: {} })
  const api = createUsageApi({ harnessAuth: facade.harnessAuth, captureUsageContext(_request, method) {
    const token = Object.freeze({ method }); tokens.push(token); return token
  } })
  const input = { binding: { session_id: 'synthetic' }, prompt_digest: 'a'.repeat(64), response: { kind: 'authorization_code', value: 'synthetic-only' } }
  await call(api, '/api/harness-auth/claude?slot=2nd', null, 'GET')
  await call(api, '/api/harness-auth/claude/start?slot=2nd')
  await call(api, '/api/harness-auth/claude/input?slot=2nd', input)
  await call(api, '/api/harness-auth/claude/cancel?slot=2nd')
  await call(api, '/api/harness-auth/claude', null, 'GET')
  assert.deepEqual(calls.map(({ method }) => method), ['auth.status', 'auth.start', 'auth.input', 'auth.cancel', 'auth.status'])
  for (const [index, item] of calls.slice(0, 4).entries()) { assert.equal(item.params.slot, '2nd'); assert.equal(item.captured, tokens[index]) }
  assert.deepEqual(calls[2].params.input, input)
  assert.deepEqual(calls[4].params, { harness: 'claude' })
  for (const query of ['slot=wrong', 'slot=1st&slot=2nd', 'slot='])
    await assert.rejects(call(api, '/api/harness-auth/claude?' + query, null, 'GET'), { code: 'HARNESS_AUTH_SLOT_INVALID' })
  assert.equal(calls.length, 5)
  const internal = createUsageApi({ internal: true, harnessAuth: facade.harnessAuth })
  assert.equal((await call(internal, '/api/harness-auth/claude/start?slot=2nd')).status, 403)
})

test('private preparation is bound to the selected auth slot and forwards only the typed execution root', async () => {
  const params = { harness: 'claude', slot: '2nd' }
  assert.equal(usageEffectValid('auth.prepareAccount', params, context, params), true)
  assert.equal(usageEffectValid('auth.prepareAccount', params, context, { harness: 'claude', slot: '1st' }), false)
  assert.equal(usageEffectValid('auth.prepareAccount', params, { ...context, method: 'onboarding.select' }, params), false)
  assert.equal(usageEffectResultValid('auth.prepareAccount', { configurationRoot: '/synthetic/2nd' }), true)
  assert.equal(usageEffectResultValid('auth.prepareAccount', { configurationRoot: '../unintended' }), false)
  const services = { accounts: { async prepare(harness, slot) { assert.deepEqual({ harness, slot }, params); return { configurationRoot: '/synthetic/2nd', history: 'shared' } } } }
  const effect = createUsageParentEffects({ getServices: () => services })
  assert.deepEqual(await effect('auth.prepareAccount', params, context), { configurationRoot: '/synthetic/2nd' })
  delete services.accounts
  await assert.rejects(effect('auth.prepareAccount', params, context), { code: 'HARNESS_AUTH_ACCOUNTS_UNAVAILABLE' })
  assert.equal(usageResultValid('auth.status', snapshot, params), true)
  assert.equal(usageResultValid('auth.status', { harness: 'claude', auth }, params), false)
  assert.equal(usageResultValid('auth.status', { harness: 'claude', auth }, { harness: 'claude' }), true)
})

test('private account listing is Claude auth scoped and projects only login metadata', async () => {
  const params = {}, result = { harnesses: [{ harness: 'claude', slots: [{ slot: '2nd', loggedIn: true, label: 'second@example.invalid' }] }] }
  assert.equal(usageEffectValid('auth.listAccounts', params, context, { harness: 'claude' }), true)
  for (const [ctx, root] of [
    [{ ...context, method: 'auth.cancel' }, { harness: 'claude' }],
    [context, { harness: 'codex' }],
    [{ ...context, kind: 'control' }, { harness: 'claude' }],
  ]) assert.equal(usageEffectValid('auth.listAccounts', params, ctx, root), false)
  assert.equal(usageEffectValid('auth.listAccounts', { slot: '2nd' }, context, { harness: 'claude' }), false)
  assert.equal(usageEffectResultValid('auth.listAccounts', result), true)
  for (const invalid of [
    { harnesses: [{ harness: 'codex', slots: [] }] },
    { harnesses: [{ harness: 'claude', slots: [{ slot: '2nd', loggedIn: true, label: null, root: '/private' }] }] },
    { harnesses: [{ harness: 'claude', slots: [{ slot: '2nd', loggedIn: 'yes', label: null }] }] },
    { harnesses: [{ harness: 'claude', slots: [{ slot: '2nd', loggedIn: true, label: null }, { slot: '2nd', loggedIn: false, label: null }] }] },
    { harnesses: [{ harness: 'claude', slots: Array(3).fill({ slot: '1st', loggedIn: null, label: null }) }] },
    { harnesses: [], extra: true },
  ]) assert.equal(usageEffectResultValid('auth.listAccounts', invalid), false)

  const services = { accounts: { async list() { return { harnesses: [
    { harness: 'codex', slots: [{ slot: '1st', loggedIn: true, label: 'wrong@example.invalid' }] },
    { harness: 'claude', slots: [{ slot: '1st', loggedIn: false, label: null, limits: [{ scope: 'private' }], seats: ['secret-bot'] },
      { slot: '2nd', loggedIn: true, label: 'second@example.invalid', configurationRoot: '/private/root' }], rules: { hidden: true }, allLimited: [{ scope: 'private' }] },
  ], privateState: 'drop-me' } } } }
  const effect = createUsageParentEffects({ getServices: () => services })
  const projected = await effect('auth.listAccounts', params, context)
  assert.deepEqual(projected, { harnesses: [{ harness: 'claude', slots: [
    { slot: '1st', loggedIn: false, label: null }, { slot: '2nd', loggedIn: true, label: 'second@example.invalid' },
  ] }] })
  assert.equal(usageEffectResultValid('auth.listAccounts', projected), true)
  delete services.accounts.list
  assert.deepEqual(await effect('auth.listAccounts', params, context), { harnesses: [] })
  services.accounts.list = async () => { throw Object.assign(new Error('old engine'), { code: 'EXECUTION_REQUEST_INVALID' }) }
  assert.deepEqual(await effect('auth.listAccounts', params, context), { harnesses: [] })
  services.accounts.list = async () => { throw Object.assign(new Error('list failed'), { code: 'ACCOUNT_LIST_FAILED' }) }
  await assert.rejects(effect('auth.listAccounts', params, context), { code: 'ACCOUNT_LIST_FAILED' })
  await assert.rejects(effect('auth.listAccounts', params, { ...context, method: 'auth.cancel' }), { code: 'USAGE_EFFECT_INVALID' })
})

test('service handoff restores in-flight paste-code binding and private login evidence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-auth-login-handoff-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls = []
  const options = { root, bots: new Map(), rooms: new Map(), effect: async (method, params) => {
    calls.push({ method, params })
    if (method === 'auth.prepareAccount') return { configurationRoot: '/synthetic/' + params.slot }
    if (method === 'auth.listAccounts') return { harnesses: [{ harness: 'claude', slots: [{ slot: params.slot ?? '2nd', loggedIn: true, label: 'second@example.invalid' }] }] }
    if (method === 'auth.call') return { structuredContent: { schema: 'aiterm.agent-auth-result.v1', status: 'blocked', session_id: 'second-session',
      account_label: null, input_required: true, auth_ui: pasteCode } }
  } }
  const service = createUsageServices(options)
  await service.initializeSettings(); await service.initialize()
  const started = await service.request('auth.start', { harness: 'claude', slot: '2nd' }, owner)
  assert.equal(started.auth.status, 'waiting')
  assert.equal(started.account_label, 'second@example.invalid')
  assert.deepEqual(started.auth.auth_ui, pasteCode)
  await service.quiesce(); const handoff = service.exportState(); service.close()
  assert.equal(handoff.receipts[0][1].loggedIn, true)
  assert.deepEqual(handoff.receipts[0][1].auth_ui, pasteCode)

  const restored = createUsageServices({ ...options, effect: async (method, params) => {
    calls.push({ method, params })
    if (method === 'auth.prepareAccount') return { configurationRoot: '/synthetic/' + params.slot }
    if (method === 'auth.listAccounts') throw Object.assign(new Error('older account engine'), { code: 'EXECUTION_REQUEST_INVALID' })
    if (method === 'auth.call') return { structuredContent: { schema: 'aiterm.agent-auth-result.v1', status: 'blocked', session_id: 'second-session',
      account_label: null, input_required: true, auth_ui: pasteCode } }
  } })
  await restored.initializeSettings({ restore: true })
  await restored.initialize({ restore: true, handoff })
  const value = await restored.request('auth.status', { harness: 'claude', slot: '2nd' }, owner)
  assert.equal(value.auth.status, 'waiting')
  assert.equal(value.account_label, 'second@example.invalid')
  assert.deepEqual(value.auth.auth_ui, pasteCode)
  assert.equal(calls.at(-1).params.session_id, 'second-session')
  assert.doesNotMatch(JSON.stringify(value), /configuration_root|synthetic\/2nd|loggedIn/)
  await restored.quiesce(); restored.close()
})

test('usage handoff retains second-slot sessions and native label without replay or credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-auth-slots-usage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls = []
  const options = { root, bots: new Map(), rooms: new Map(), effect: async (method, params) => {
    calls.push({ method, params })
    if (method === 'auth.prepareAccount') return { configurationRoot: '/synthetic/' + params.slot }
    if (method === 'auth.call') return { structuredContent: { schema: 'aiterm.agent-auth-result.v1', status: 'waiting', session_id: 'second-session', account_label: 'second@example.invalid' } }
  } }
  const service = createUsageServices(options)
  await service.initializeSettings(); await service.initialize()
  await service.request('auth.start', { harness: 'claude', slot: '2nd' }, owner)
  assert.equal(calls.at(-1).params.configuration_root, '/synthetic/2nd')
  await service.quiesce(); const handoff = service.exportState(); service.close()
  assert.deepEqual(handoff.sessions, [['claude:2nd', 'second-session']])
  assert.equal(handoff.receipts[0][1].slot, '2nd')
  assert.equal(handoff.receipts[0][1].account_label, 'second@example.invalid')
  const restored = createUsageServices(options)
  await restored.initializeSettings({ restore: true })
  const count = calls.length
  await restored.initialize({ restore: true, handoff })
  assert.equal(calls.length, count)
  const value = await restored.request('auth.status', { harness: 'claude', slot: '2nd' }, owner)
  assert.equal(value.slot, '2nd'); assert.equal(value.account_label, 'second@example.invalid')
  assert.equal(calls.at(-1).params.session_id, 'second-session')
  assert.equal(calls.filter(item => item.method === 'auth.call' && item.params.action === 'start').length, 1)
  assert.doesNotMatch(JSON.stringify(value), /configuration_root|synthetic\/2nd/)
  await restored.quiesce(); restored.close()
})
