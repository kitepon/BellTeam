import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BotRegistry } from '../src/bot-registry.mjs'
import { loadBots } from '../src/bots.mjs'
import { Onboarding } from '../src/onboarding.mjs'
import { BackgroundAgentSettings, backgroundRecordValid, backgroundInputValid } from '../src/usage/background-agent-settings.mjs'
import { readRunningExclusions } from '../src/running-exclusions.mjs'
import { validateMembersProjection } from '../src/members/protocol.mjs'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { RETIRED_HARNESS_NOTICE } from '../src/retired-harness.mjs'

// a365: a data dir written while Antigravity was a harness still starts, shows and can be switched; nothing is deleted.
const models = { forHarness: async () => ({ efforts: ['low', 'high'], models: [] }) }
async function dataDir(t) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-retired-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const seedPath = join(root, 'bots.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [{ id: 'bot-old', displayName: '旧メンバー', harness: 'antigravity', session: 'bot-old', project: '/old' }] }))
  return { root, seedPath }
}

test('Antigravityのメンバーが残る保存領域でBot名簿が起動し、案内文が付き、他のAIへ切り替えられる', async t => {
  const { root, seedPath } = await dataDir(t)
  assert.equal((await loadBots(seedPath)).get('bot-old').harness, 'antigravity')
  const registry = new BotRegistry({ seedPath, botsRoot: join(root, 'bots'), models, botId: () => 'bot-new' })
  await registry.initialize()
  assert.equal(registry.get('bot-old').harness, 'antigravity')
  assert.equal(registry.get('bot-old').harnessNotice, RETIRED_HARNESS_NOTICE)
  assert.equal((await registry.listForClient()).find(bot => bot.id === 'bot-old').harnessNotice, RETIRED_HARNESS_NOTICE)
  // Other fields can still be edited; the stored harness is kept (nothing is deleted).
  assert.equal((await registry.update('bot-old', { name: '改名', harness: 'antigravity' })).name, '改名')
  assert.equal(JSON.parse(await readFile(join(root, 'bots/bot-old/bot.json'), 'utf8')).harness, 'antigravity')
  // Nothing new may choose it.
  await assert.rejects(registry.create({ name: '新規', harness: 'antigravity' }), /BOT_HARNESS_INVALID/u)
  await registry.refresh()
  const switched = await registry.update('bot-old', { harness: 'claude' })
  assert.equal(switched.harness, 'claude')
  assert.equal(Object.hasOwn(switched, 'harnessNotice'), false)
  await assert.rejects(registry.update('bot-old', { harness: 'antigravity' }), /BOT_HARNESS_INVALID/u)
  // The members worker projection accepts the stored value, with the notice.
  const context = { generation: 'test', leaseId: 'lease', rootId: 'root', ownerWrite: false, continuation: false }
  validateMembersProjection({ type: 'profile', revision: 1, bot: { id: 'bot-old', name: '旧', harness: 'antigravity', session: 'bot-old', harnessNotice: RETIRED_HARNESS_NOTICE } }, context)
})

test('初期設定の保存にAntigravityが残っていても読み込める', async t => {
  const { root, seedPath } = await dataDir(t)
  const bots = new BotRegistry({ seedPath, botsRoot: join(root, 'bots') })
  await bots.initialize()
  await mkdir(join(root, 'shared'), { recursive: true })
  const path = join(root, 'shared/onboarding.json')
  for (const [started, phase, harness] of [[false, 'select_harness', null], [true, 'ready', 'antigravity']]) {
    await writeFile(path, JSON.stringify({ schema: 'bellteam.onboarding.v1', harness: 'antigravity', guideBotId: null, authSession: null, started, complete: started }))
    const onboarding = new Onboarding({ root, bots, client: { call: async () => ({}) }, subscriptions: {}, startConversation: async () => {} })
    await onboarding.initialize()
    const snapshot = onboarding.snapshot()
    assert.equal(snapshot.phase, phase)
    assert.equal(snapshot.harness, harness)
    assert.equal(snapshot.harnessNotice, started ? RETIRED_HARNESS_NOTICE : undefined)
    assert.equal(JSON.parse(await readFile(path, 'utf8')).harness, 'antigravity')
  }
})

test('背景agentの保存はAntigravityのまま読めるが、新しく選べない', async t => {
  const { root } = await dataDir(t)
  const record = { revision: '11111111-1111-4111-8111-111111111111', selection: { harness: 'antigravity', model: 'old-model', reasoningEffort: '' } }
  assert.equal(backgroundRecordValid(record), true)
  assert.equal(backgroundInputValid({ expectedRevision: record.revision, harness: 'antigravity', model: 'old-model', reasoningEffort: '' }), true)
  const path = join(root, 'shared/tools/bellteam-settings/background-agent.json')
  await mkdir(join(root, 'shared/tools/bellteam-settings'), { recursive: true })
  await writeFile(path, JSON.stringify({ schema: 'bellteam.background-agent-settings.v1', ...record }))
  const settings = new BackgroundAgentSettings({ root, models: async () => [{ id: 'm', efforts: [] }] })
  await settings.initialize()
  assert.deepEqual(settings.configuration(), record)
  await assert.rejects(settings.update({ expectedRevision: record.revision, harness: 'antigravity', model: 'old-model', reasoningEffort: '' }), { code: 'BACKGROUND_AGENT_HARNESS_INVALID' })
  assert.equal((await settings.update({ expectedRevision: record.revision, harness: 'claude', model: 'm', reasoningEffort: '' })).selection.harness, 'claude')
})

test('実行中の除外の保存にAntigravityの子の席が残っていても一覧は捨てられない', async t => {
  const { root } = await dataDir(t)
  const path = join(root, 'exclusions.json')
  const entries = [{ id: 'x1', kind: 'child', harness: 'antigravity-cli', session: null, scope: 'all' }, { id: 'x2', kind: 'child', harness: 'claude-code', session: null, scope: 'all' }]
  await writeFile(path, JSON.stringify({ schema: 'bellteam.running-exclusions.v1', entries }))
  assert.deepEqual(await readRunningExclusions(path), entries)
})

test('Antigravityの席は起動せず、案内文つきのHARNESS_RETIREDを返す', async () => {
  const transport = new AitermTransport({ client: { call: async name => { if (name === 'pty_list') return { content: [{ type: 'text', text: '(セッション無し)' }] }; throw new Error('Aitermを起動してはならない') } } })
  await assert.rejects(transport.ensure({ id: 'bot-old', session: 'bot-old', harness: 'antigravity', project: join(tmpdir(), 'bellteam-retired-seat') }),
    { code: 'HARNESS_RETIRED', effect: 'not_started', message: RETIRED_HARNESS_NOTICE })
})
