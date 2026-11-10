import assert from 'node:assert/strict'
import test from 'node:test'
import { configurationReceipt } from '../src/configuration-request.mjs'

const receipt = (binding, change = {}) => ({ schema: 'aiterm.agent-configure-request-result.v1', binding,
  request_state: 'terminal', outcome: 'not_applied', later_effect: 'excluded', terminal_at: '2026-11-03T07:00:00.000Z',
  result: null, current: { availability: 'unsupported' }, observed_at: '2026-11-03T07:00:01.000Z', ...change })
const applied = binding => receipt(binding, { outcome: 'applied', later_effect: 'unconfirmed', result: {
  schema: 'aiterm.agent-configure-result.v1', session_id: binding.session_id, provider: 'codex', harness: 'codex-cli', model: 'next', reasoning_effort: 'high', fast: null,
} })

test('strict receipt rejects wrong binding and contradictory states', () => {
  const binding = { id: 'a1234567-1234-4123-8123-123456789abc', session_id: 'original', launch_id: '1'.repeat(32), digest: '2'.repeat(64) }
  for (const changed of [{ binding: { ...binding, launch_id: '3'.repeat(32) } }, { extra: true },
    { request_state: 'not_recorded' }, { outcome: 'applied' }, { terminal_at: '2026-02-31T00:00:00Z' },
    { current: { availability: 'available' } }, { request_state: 'pending_or_unknown', terminal_at: null, later_effect: 'excluded' }])
    assert.throws(() => configurationReceipt(receipt(binding, changed), binding), { code: 'CONFIGURATION_RESULT_UNCONFIRMED' })
})

test('a returned refusal is read back by the same ID and reported as not applied with its reason', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { AitermClient } = await import('../src/aiterm-client.mjs')
  const { ConfigurationIntents } = await import('../src/configuration-intents.mjs')
  const { ConfigurationRequests } = await import('../src/configuration-requests.mjs')
  const { BotAdministration } = await import('../src/bot-administration.mjs')
  const root = await mkdtemp(join(tmpdir(), 'configure-refusal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const text = 'aiterm: CLAUDE_MODEL_NOT_IN_PICKER vendor=claude session=bot-a\nClaude Codeの /model の選ぶ画面に fable がありません。modelとreasoning_effortは変えていません。'
  for (const later_effect of ['unconfirmed', 'excluded']) {
    const calls = []
    const client = new AitermClient({ env: {} })
    client.client = { async callTool({ arguments: args }) {
      calls.push(args.action)
      const stored = receipt({ ...args.request, session_id: args.session_id }, { later_effect })
      return args.action === 'apply' ? { isError: true, content: [{ type: 'text', text }], structuredContent: stored } : { structuredContent: stored }
    } }
    const requests = new ConfigurationRequests({ client, intents: new ConfigurationIntents(join(root, later_effect), { ownerUid: process.getuid() }) })
    const error = await requests.apply('bot-a', 'bot-a', '1'.repeat(32), { model: 'fable', reasoning_effort: 'high' })
      .then(() => assert.fail('a terminal not_applied must reject'), value => value)
    assert.deepEqual(calls, ['apply', 'reconcile'])
    assert.equal(error.code, 'CONFIGURATION_NOT_APPLIED')
    assert.equal(error.effect, later_effect === 'excluded' ? 'not_started' : 'possible')
    assert.equal(error.reason, 'Claude Codeの /model の選ぶ画面に fable がありません。modelとreasoning_effortは変えていません。')
    assert.equal(requests.view('bot-a').receipt.outcome, 'not_applied')

    const bots = new Map([['bot-a', { id: 'bot-a', harness: 'claude', model: 'opus', reasoningEffort: 'high', fastMode: false }]])
    bots.refresh = async () => {}
    bots.previewUpdate = async (id, changes) => ({ ...bots.get(id), ...changes })
    bots.update = async (id, changes) => { const next = { ...bots.get(id), ...changes }; bots.set(id, next); return next }
    const admin = new BotAdministration({ bots, rooms: {}, writeLog: () => {}, transport: {
      async isRunning() { return true }, async runningBots() { return new Set(['bot-a']) }, reconfigure: async () => { throw error } } })
    await admin.update('bot-a', { model: 'fable' })
    await admin.applicationCompletions.get('bot-a')
    const state = admin.view(bots.get('bot-a')).configurationApplication
    assert.equal(state.state, 'failed')
    assert.equal(state.outcome, 'not_applied')
    assert.match(state.message, /^設定変更は反映されませんでした。Claude Codeの \/model の選ぶ画面に fable がありません。/u)
  }
})
