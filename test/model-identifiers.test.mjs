import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { BotRegistry } from '../src/bot-registry.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'

// IDs returned by the live official Claude model catalog on 2026-10-25.
const ids = ['default', 'opus', 'claude-fable-5-1[1m]', 'sonnet', 'haiku']
test('CLIが返す全Claudeモデルを通常HTTPで保存し、Fableのコンテキスト指定を起動設定と再読込へ保持する', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-model-id-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const seedPath = join(root, 'seed.json'), botsRoot = join(root, 'bots')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [{ id: 'bot-test', displayName: '人工メンバー', harness: 'codex', session: 'bot-test', project: '/synthetic/project' }] }))
  const models = { forHarness: async () => ({ efforts: ['high'], models: ids.map(id => ({ id, efforts: ['high'], fast: false })) }) }
  const bots = new BotRegistry({ seedPath, botsRoot, models }); await bots.initialize()
  const applied = [], transport = { isRunning: async () => true, reconfigure: async (_before, next) => { applied.push({ harness: next.harness, model: next.model }) } }
  const server = createBellTeamServer({ bots, models, transport, authorize: () => true, writeLog() {} })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/bots/bot-test`
    for (const model of ids) {
      const response = await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ harness: 'claude', model, reasoningEffort: 'high' }) })
      assert.equal(response.status, 200, `${model}: ${await response.clone().text()}`)
      assert.equal((await response.json()).bot.model, model)
      await bots.refresh(); assert.equal(bots.get('bot-test').model, model)
      assert.deepEqual(applied.at(-1), { harness: 'claude', model })
    }
    await bots.update('bot-test', { model: 'claude-fable-5-1[1m]' })
    const restarted = new BotRegistry({ seedPath, botsRoot, models }); await restarted.initialize()
    assert.equal(restarted.get('bot-test').model, 'claude-fable-5-1[1m]')
    assert.equal(restarted.get('bot-test').reasoningEffort, 'high')
    const before = restarted.get('bot-test').model
    await assert.rejects(restarted.update('bot-test', { model: 'model\n--other-option' }), /BOT_MODEL_INVALID/)
    assert.equal(restarted.get('bot-test').model, before)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
