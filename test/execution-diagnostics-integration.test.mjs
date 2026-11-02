import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createApplicationServices } from '../src/application-services.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'
import { Diagnostics } from '../src/diagnostics.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))

test('同じサービス組立てのモデル拒否と追跡失敗が共通診断へ届く', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bt-execution-diag-integration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bot = { id: 'bot-fixture', project: join(root, 'bot'), session: 'fixture-seat', harness: 'codex', model: 'old-model', reasoningEffort: 'high' }
  const bots = new Map([[bot.id, bot]])
  bots.previewUpdate = async (id, changes) => ({ ...bots.get(id), ...changes })
  bots.update = async (id, changes) => { const next = { ...bots.get(id), ...changes }; bots.set(id, next); return next }
  const services = await createApplicationServices({ root, bots, environment: {},
    client: { async close() {} }, settings: {}, refreshGlobalInstructions: async () => {} })
  t.after(() => services.notifications.close())
  services.transport.isRunning = async () => true
  services.transport.reconfigure = async () => {
    throw Object.assign(new Error('private fixture configure text'), { effect: 'not_started' })
  }
  await services.administration.update(bot.id, { model: 'new-model' })
  await tick(); await tick(); await services.diagnostics.pending
  assert.equal(services.administration.view(bots.get(bot.id)).configurationApplication.state, 'failed')
  services.transport.waitUntilDone = async () => {
    throw Object.assign(new Error('private fixture process text'), { code: 'SEAT_PROCESS_FAILED', exitCode: 3 })
  }
  services.transport.watchTurn(bot, bot.session, { turn_id: 'fixture-turn', wait_process: {} },
    { groupId: () => 'fixture-group' })
  const watch = services.transport.activity.watches.get(bot.id)
  t.after(async () => { watch.end(); await watch.completion })
  await tick(); await tick(); await services.diagnostics.pending
  const rows = services.diagnostics.list()
  assert.deepEqual(rows.map(row => row.category).sort(),
    ['SERVER_MODEL_CONFIGURATION_FAILED', 'SERVER_TURN_TRACKING_FAILED'])
  for (const row of rows) {
    assert.equal(JSON.parse(row.diagnostic_log).schema, 'bellteam.execution-failure.v1')
    assert.doesNotMatch(row.diagnostic_log, /private fixture|stack|stdout|stderr/u)
    assert.equal(row.occurrence_count, 1)
  }
})

test('HTTP既定Administrationの非同期適用拒否も診断へ保存する', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bt-http-execution-diag-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bot = { id: 'bot-fixture', harness: 'codex', model: 'old-model', reasoningEffort: 'high' }
  const bots = new Map([[bot.id, bot]])
  bots.refresh = async () => {}
  bots.previewUpdate = async (id, changes) => ({ ...bots.get(id), ...changes })
  bots.update = async (id, changes) => { const next = { ...bots.get(id), ...changes }; bots.set(id, next); return next }
  const diagnostics = new Diagnostics(join(root, 'diagnostics.json'))
  await diagnostics.initialize()
  const server = createBellTeamServer({ bots, diagnostics, authorize: () => true, writeLog: () => {},
    transport: { async isRunning() { return true }, async reconfigure() {
      throw Object.assign(new Error('private HTTP fixture'), { effect: 'not_started' })
    } } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bots/${bot.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'new-model' }),
  })
  assert.equal(response.status, 200)
  await tick(); await diagnostics.pending
  const [row] = diagnostics.list()
  assert.equal(row.category, 'SERVER_MODEL_CONFIGURATION_FAILED')
  assert.equal(JSON.parse(row.diagnostic_log).effect, 'not_started')
  assert.doesNotMatch(row.diagnostic_log, /private HTTP/u)
})
