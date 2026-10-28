import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const root = process.env.BELLTEAM_MODEL_STATE_SOURCE
  ? pathToFileURL(process.env.BELLTEAM_MODEL_STATE_SOURCE + '/') : new URL('../', import.meta.url)
const { BotAdministration } = await import(new URL('src/bot-administration.mjs', root))
const { AitermClient } = await import(new URL('src/aiterm-client.mjs', root))
const { AitermTransport } = await import(new URL('src/aiterm-transport.mjs', root))
const { createBotApi } = await import(new URL('src/http-bot-api.mjs', root))
const { callBellTeamTool } = await import(new URL('src/mcp-tools.mjs', root))
const tick = () => new Promise(resolve => setImmediate(resolve))

async function configureError(failure) {
  const client = new AitermClient({ env: {} })
  client.client = { async callTool() { return { isError: true,
    content: [{ type: 'text', text: 'synthetic native configure refusal' }], structuredContent: failure } } }
  return client.call('agent_configure', { session_id: 'bot-a', fast: true })
    .then(() => assert.fail('native refusal must reject'), error => error)
}

function fixture(harness) {
  const bots = new Map([['bot-a', { id: 'bot-a', harness, model: 'old-model', reasoningEffort: 'high', fastMode: false }]])
  bots.refresh = async () => {}
  bots.previewUpdate = async (id, changes) => ({ ...bots.get(id), ...changes })
  bots.update = async (id, changes) => {
    const next = { ...bots.get(id), ...changes }; bots.set(id, next); return next
  }
  const pending = [], logs = []
  const transport = {
    async isRunning() { return true },
    async runningBots() { return new Set(['bot-a']) },
    reconfigure(current, next, options) {
      return new Promise((resolve, reject) => pending.push({ current, next, options, resolve, reject }))
    },
  }
  const admin = new BotAdministration({ bots, transport, rooms: {}, writeLog: value => logs.push(value) })
  return { bots, transport, admin, pending, logs }
}

test('typed configure: all harnesses preserve request effect and only restore fast for not-started refusals', async () => {
  for (const harness of ['claude', 'codex', 'grok', 'cursor']) {
    for (const [outcome, effect] of [['not_applied', 'not_started'], ['outcome_unknown', 'possible']]) {
      const failure = { schema: 'aiterm.agent-configure-error.v1', session_id: 'bot-a', outcome, effect }
      const error = await configureError(failure)
      assert.equal(error.message, 'synthetic native configure refusal')
      assert.deepEqual(error.agentConfigureResult, failure)
      const f = fixture(harness)
      await f.admin.update('bot-a', { fastMode: true })
      f.pending[0].reject(error)
      await tick(); await tick()
      const state = f.admin.view(f.bots.get('bot-a')).configurationApplication
      assert.equal(state.state, 'failed')
      assert.equal(state.outcome, outcome)
      assert.equal(state.effect, effect)
      assert.equal(f.bots.get('bot-a').fastMode, effect === 'possible')
      assert.equal(f.pending.length, 1, 'uncertain effect never triggers an automatic retry')
    }
  }
})

test('typed configure: wrong session or invalid outcome/effect cannot claim not-started or restore fast', async () => {
  for (const change of [{ session_id: 'other' }, { effect: 'possible' }, { outcome: 'unexpected' }]) {
    const error = await configureError({ schema: 'aiterm.agent-configure-error.v1', session_id: 'bot-a',
      outcome: 'not_applied', effect: 'not_started', ...change })
    assert.equal(error.agentConfigureResult, null)
    const f = fixture('codex')
    await f.admin.update('bot-a', { fastMode: true })
    f.pending[0].reject(error)
    await tick(); await tick()
    const state = f.admin.view(f.bots.get('bot-a')).configurationApplication
    assert.equal(state.outcome, 'outcome_unknown')
    assert.equal(state.effect, 'possible')
    assert.equal(f.bots.get('bot-a').fastMode, true)
  }
})

test('issued configure without a confirmed result preserves fast preference and reports uncertainty', async () => {
  for (const harness of ['claude', 'codex', 'grok', 'cursor']) {
    for (const response of ['lost', 'missing-schema', 'unknown-schema']) {
      let calls = 0
      const client = new AitermClient({ env: {} })
      client.client = { async callTool() {
        calls++
        if (response === 'lost') throw new Error('synthetic RPC timeout after configure')
        return { isError: true, content: [{ type: 'text', text: 'synthetic unconfirmed configure' }],
          ...(response === 'unknown-schema' ? { structuredContent: {
            schema: 'unknown', session_id: 'bot-a', outcome: 'not_applied', effect: 'not_started',
          } } : {}) }
      } }
      const native = new AitermTransport({ client })
      const f = fixture(harness)
      f.bots.set('bot-a', { ...f.bots.get('bot-a'), session: 'bot-a' })
      f.transport.reconfigure = (...args) => native.reconfigure(...args)
      await f.admin.update('bot-a', { fastMode: true })
      await tick(); await tick()
      const state = f.admin.view(f.bots.get('bot-a')).configurationApplication
      assert.equal(state.state, 'failed')
      assert.equal(state.outcome, 'outcome_unknown', `${harness}/${response}`)
      assert.equal(state.effect, 'possible')
      assert.equal(f.bots.get('bot-a').fastMode, true)
      assert.equal(calls, 1, 'no automatic retry')
      assert.equal(native.uncertainChanges.has('bot-a'), response === 'lost')
    }
  }
})

async function readApi(f, pathname) {
  let status, raw
  const api = createBotApi({ bots: f.bots, transport: f.transport, administration: f.admin,
    sources: async () => [], store: {} })
  await api({ method: 'GET' }, { writeHead(value) { status = value }, end(value) { raw = value } }, new URL(pathname, 'http://synthetic'))
  assert.equal(status, 200)
  return JSON.parse(raw)
}

for (const harness of ['claude', 'codex', 'grok', 'cursor']) {
  test(`${harness}: async refusal stays visible in settings/MCP and identical explicit retry can be accepted`, async () => {
    const f = fixture(harness)
    const saved = await f.admin.update('bot-a', { model: 'desired-model' })
    assert.equal(saved.bot.configurationApplication?.state, 'pending')
    f.pending[0].reject(new Error('synthetic native refusal'))
    await tick(); await tick()
    assert.equal(f.bots.get('bot-a').model, 'desired-model', 'desired preference is retained')
    for (const record of [(await readApi(f, '/api/bots/bot-a')).bot,
      (await readApi(f, '/api/bots')).bots[0],
      (await callBellTeamTool({ name: 'get_self', from: 'bot-a', registry: f.bots,
        botView: bot => f.admin.view(bot) })).bot,
      (await callBellTeamTool({ name: 'get_bot', arguments: { botId: 'bot-a' }, from: 'bot-a', registry: f.bots,
        botView: bot => f.admin.view(bot) })).bot]) {
      assert.equal(record.configurationApplication.state, 'failed')
      assert.equal(record.configurationApplication.requested.model, 'desired-model')
      assert.equal(Object.hasOwn(record.configurationApplication, 'actualModel'), false)
    }
    assert.match(f.logs[0], /bot-a/u)
    await f.admin.update('bot-a', { role: 'profile-only' })
    assert.equal(f.pending.length, 1, 'profile change never retries native configuration')
    const retry = await f.admin.update('bot-a', { model: 'desired-model' })
    assert.equal(retry.applying, true)
    assert.equal(f.pending.length, 2)
    assert.equal(f.pending[1].options.reapply, true)
    f.pending[1].resolve({ model: 'desired-model' })
    await tick()
    const result = f.admin.view(f.bots.get('bot-a')).configurationApplication
    assert.equal(result.state, 'accepted')
    assert.equal(Object.hasOwn(result, 'actualModel'), false, 'an echoed model is not measured actual model')
    const detached = f.admin.view(f.bots.get('bot-a'))
    detached.configurationApplication.state = 'modified-by-reader'
    assert.equal(f.admin.view(f.bots.get('bot-a')).configurationApplication.state, 'accepted')
  })
}

test('late old failure cannot roll back the latest fast preference or overwrite its pending state', async () => {
  const f = fixture('codex')
  await f.admin.update('bot-a', { fastMode: true })
  await f.admin.update('bot-a', { model: 'newer-model' })
  f.pending[0].reject(new Error('old operation refused'))
  await tick(); await tick()
  assert.equal(f.bots.get('bot-a').fastMode, true)
  assert.equal(f.admin.view(f.bots.get('bot-a')).configurationApplication.requested.model, 'newer-model')
  assert.equal(f.admin.view(f.bots.get('bot-a')).configurationApplication.state, 'pending')
  f.pending[1].resolve(); await tick()
  assert.equal(f.admin.view(f.bots.get('bot-a')).configurationApplication.state, 'accepted')
})

test('a failed settings save does not issue any native change', async () => {
  const f = fixture('codex')
  f.bots.update = async () => { throw new Error('synthetic save failed') }
  await assert.rejects(f.admin.update('bot-a', { model: 'desired-model' }), /save failed/u)
  assert.equal(f.pending.length, 0)
  assert.equal(f.bots.get('bot-a').model, 'old-model')
})

test('explicit reapply sends all current requested values through the normal adapter on all four harnesses', async () => {
  for (const harness of ['claude', 'codex', 'grok', 'cursor']) {
    const calls = []
    const transport = new AitermTransport({ client: { async call(name, args) { calls.push({ name, args }); return {} } } })
    const current = { id: 'bot-a', session: 'bot-a', harness, model: 'desired-model', reasoningEffort: 'high', fastMode: false }
    await transport.reconfigure(current, { ...current }, { reapply: true })
    assert.deepEqual(calls, [{ name: 'agent_configure', args: {
      session_id: 'bot-a', model: 'desired-model', reasoning_effort: 'high', fast: false,
    } }])
  }
})

test('model-only change sends the saved explicit effort on all harnesses', async () => {
  for (const harness of ['claude', 'codex', 'grok', 'cursor']) {
    const calls = []
    const transport = new AitermTransport({ client: { async call(name, args) { calls.push({ name, args }); return {} } } })
    const current = { id: 'bot-a', session: 'bot-a', harness, model: 'old-model', reasoningEffort: 'high', fastMode: false }
    await transport.reconfigure(current, { ...current, model: 'new-model' })
    assert.deepEqual(calls, [{ name: 'agent_configure', args: { session_id: 'bot-a', model: 'new-model', reasoning_effort: 'high' } }], harness)
  }
})
