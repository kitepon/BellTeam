import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createApplicationServices } from '../src/application-services.mjs'

test('組立てたGoalは読取と変更の失敗を記録し、元の未確認結果を返す', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bt-goal-diag-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const services = await createApplicationServices({ root, bots: new Map(), environment: {},
    client: { async close() {} }, settings: {}, refreshGlobalInstructions: async () => {} })
  t.after(() => services.notifications.close())
  const launch = 'a'.repeat(32), bot = { id: 'synthetic-bot', session: 'synthetic-seat' }
  const calls = []
  services.transport.session = () => bot.session
  services.transport.observe = async () => ({ schema: 'aiterm.pty-observe-result.v1', session_id: bot.session, exists: true, launch_id: launch })
  services.transport.client.call = async (name, args) => {
    calls.push({ name, action: args.action })
    throw new Error('synthetic private goal text must not be logged')
  }
  const snapshot = await services.goals.inspect(bot)
  assert.equal(snapshot.availability, 'unavailable')
  const result = await services.goals.mutate(bot, { action: 'pause', binding: {
    sessionId: bot.session, launchId: launch, threadId: 'synthetic-thread',
  } }, { origin: 'user' })
  assert.equal(result.outcome, 'unconfirmed')
  assert.equal(result.snapshot.availability, 'unavailable')
  assert.deepEqual(calls, [{ name: 'agent_goal', action: 'inspect' }, { name: 'agent_goal', action: 'pause' }])
  const [row] = services.diagnostics.list()
  assert.equal(row.category, 'GOAL_OPERATION_UNCONFIRMED')
  assert.equal(row.module, 'goals')
  assert.equal(row.occurrence_count, 2)
  assert.doesNotMatch(row.diagnostic_log, /synthetic private goal text/)
})
