import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { BotRegistry } from '../src/bot-registry.mjs'
import { loadBots } from '../src/bots.mjs'
import { Onboarding } from '../src/onboarding.mjs'
import { BackgroundAgentSettings, backgroundRecordValid, backgroundInputValid } from '../src/usage/background-agent-settings.mjs'
import { readRunningExclusions } from '../src/running-exclusions.mjs'
import { validateMembersProjection } from '../src/members/protocol.mjs'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { RETIRED_HARNESS_NOTICE } from '../src/retired-harness.mjs'
import { usageEffectResultValid } from '../src/usage/channel-protocol.mjs'
import { createUsageRegistryPorts } from '../src/usage/registry-ports.mjs'
import { createMemberProfileApi } from '../src/members/profiles-http.mjs'
import { usageEffectValid } from '../src/usage/channel-protocol.mjs'
import { usageResultValid } from '../src/usage/process-results.mjs'
import { createUsageParentEffects } from '../src/usage-parent-effects.mjs'
import { createUsageAssembly } from '../src/usage-assembly.mjs'
import { createUsageApi } from '../src/usage/http-api.mjs'
import { authReceipt, authUi } from '../src/auth-ui.mjs'

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
  // a368: the notice never rides inside module IPC records (an older body rejects unknown bot fields); HTTP adds it.
  assert.equal(Object.hasOwn(registry.get('bot-old'), 'harnessNotice'), false)
  assert.equal(Object.hasOwn((await registry.listForClient()).find(bot => bot.id === 'bot-old'), 'harnessNotice'), false)
  // Other fields can still be edited; the stored harness is kept (nothing is deleted).
  assert.equal((await registry.update('bot-old', { name: '改名', harness: 'antigravity' })).name, '改名')
  assert.equal(JSON.parse(await readFile(join(root, 'bots/bot-old/bot.json'), 'utf8')).harness, 'antigravity')
  // Nothing new may choose it.
  await assert.rejects(registry.create({ name: '新規', harness: 'antigravity' }), /BOT_HARNESS_INVALID/u)
  await registry.refresh()
  const switched = await registry.update('bot-old', { harness: 'claude' })
  assert.equal(switched.harness, 'claude')
  await assert.rejects(registry.update('bot-old', { harness: 'antigravity' }), /BOT_HARNESS_INVALID/u)
  // The members worker projection accepts the stored value.
  const context = { generation: 'test', leaseId: 'lease', rootId: 'root', ownerWrite: false, continuation: false }
  validateMembersProjection({ type: 'profile', revision: 1, bot: { id: 'bot-old', name: '旧', harness: 'antigravity', session: 'bot-old' } }, context)
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
    // a374: the record keeps its six fields (the body's IPC check is exact); the notice is added at the HTTP edge.
    assert.deepEqual(Object.keys(snapshot).sort(), ['auth', 'complete', 'guideBotId', 'harness', 'harnesses', 'phase'])
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

// a368: the train swaps one component at a time, so each half must accept a member list that still names Antigravity.
test('Antigravityのメンバーを含む一覧を、本体の結果検査とusageの受け口が受け入れる', async () => {
  const list = [{ id: 'bot-old', name: '旧', harness: 'antigravity' }, { id: 'bot-new', name: '新', harness: 'claude' }]
  assert.equal(usageEffectResultValid('members.read', list), true)
  assert.equal(usageEffectResultValid('members.read', [{ id: 'x', name: 'x', harness: 'gemini' }]), false)
  const ports = createUsageRegistryPorts({ effect: async () => list, initialMembers: list })
  assert.equal(ports.bots.get('bot-old').harness, 'antigravity')
  await ports.bots.refresh()
  assert.throws(() => createUsageRegistryPorts({ effect: async () => [], initialMembers: [{ id: 'x', name: 'x', harness: 'gemini' }] }), { code: 'USAGE_MEMBERS_INVALID' })
})

test('案内文はHTTPで付き、モジュールの記録には載らない', async t => {
  const { root, seedPath } = await dataDir(t)
  const registry = new BotRegistry({ seedPath, botsRoot: join(root, 'bots'), models })
  await registry.initialize()
  // An older body validates module records with exact bot fields; harnessNotice is not one of them.
  const old = new Set(['id', 'name', 'harness', 'session', 'project', 'displayName', 'model', 'reasoningEffort', 'fastMode', 'configurationLocked', 'color', 'profileText', 'personality', 'speechStyle', 'position', 'role', 'avatar', 'avatarLarge', 'avatarSource', 'avatarLargeSource', 'avatarCrop', 'avatarLargeCrop', 'terminalId', 'projectRoot'])
  for (const key of Object.keys(registry.get('bot-old'))) assert.equal(old.has(key), true, key)
  const api = createMemberProfileApi({ bots: registry, administration: {}, sources: async () => [], transport: { runningBots: async () => new Set() }, store: { recentViews: async () => new Map() } })
  const response = { writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body) } }
  await api({ method: 'GET' }, response, new URL('http://fixture/api/bots'))
  assert.equal(response.body.bots.find(bot => bot.id === 'bot-old').harnessNotice, RETIRED_HARNESS_NOTICE)
})

// a374: body and usage ship separately and each checks the other's records exactly, so these run the real pair.
const guide = root => ({ id: 'bot-guide', name: '案内役', harness: 'antigravity', project: join(root, 'bots/bot-guide') })
function bodyServices(root, aiterm) {
  const bots = new Map([['bot-guide', guide(root)]])
  bots.refresh = async () => {}
  bots.update = async (id, changes) => Object.assign(bots.get(id), changes)
  return { bots, rooms: Object.assign(new Map(), { refresh: async () => {} }), notifications: {}, messenger: {},
    transport: { client: { call: async (_name, params) => { aiterm.push(`${params.harness}:${params.action}`)
      return { structuredContent: { schema: 'aiterm.agent-auth-result.v1', harness: params.harness, status: 'waiting', session_id: 's1', url: null, user_code: null, input_required: false, message: null } } } } } }
}

for (const started of [false, true]) test(`Antigravityが残る保存領域で、実物のusageの部品が本体の組み立てで起動する（初期設定${started ? '開始済み' : '開始前'}）`, { timeout: 60000 }, async t => {
  const { root } = await dataDir(t)
  await mkdir(join(root, 'state'), { recursive: true }); await mkdir(join(root, 'shared/tools/bellteam-settings'), { recursive: true })
  await writeFile(join(root, 'shared/onboarding.json'), JSON.stringify({ schema: 'bellteam.onboarding.v1', harness: 'antigravity', guideBotId: 'bot-guide', authSession: null, started, complete: false }))
  const background = { revision: '11111111-1111-4111-8111-111111111111', selection: { harness: 'antigravity', model: 'old-model', reasoningEffort: '' } }
  await writeFile(join(root, 'shared/tools/bellteam-settings/background-agent.json'), JSON.stringify({ schema: 'bellteam.background-agent-settings.v1', ...background }))
  const aiterm = [], children = [], services = bodyServices(root, aiterm)
  const assembly = createUsageAssembly({ root, getServices: () => services, onState: () => {},
    onEffect: createUsageParentEffects({ getServices: () => services, getFeatures: () => null, seatRuntime: null }),
    spawnProcess: (_entry, args, options) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/usage-runtime-child.mjs', import.meta.url)), root, args[0]], { ...options, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
      children.push(child); return child
    } })
  t.after(async () => { await assembly.close().catch(() => {}); for (const child of children) child.kill('SIGKILL') })
  const owner = method => assembly.capture(method, { kind: 'owner', botId: null })
  // initializeServices ends with the ready probe (one onboarding.status); a refused record or effect fails it.
  await assembly.initializeSettings(); await assembly.initializeSubscriptions(); await assembly.initializeServices()
  const setup = await assembly.facade.onboarding.status(owner('onboarding.status'))
  assert.deepEqual(Object.keys(setup).sort(), ['auth', 'complete', 'guideBotId', 'harness', 'harnesses', 'phase'])
  assert.deepEqual([setup.phase, setup.harness], started ? ['ready', 'antigravity'] : ['select_harness', null])
  assert.deepEqual(setup.harnesses.map(item => item.id), ['claude', 'codex', 'grok', 'cursor'])
  assert.deepEqual(await assembly.facade.settings.backgroundAgentConfiguration(), background)
  if (!started) {
    const chosen = await assembly.facade.onboarding.select('claude', owner('onboarding.select'))
    assert.deepEqual([chosen.phase, chosen.harness, services.bots.get('bot-guide').harness], ['authenticate', 'claude', 'claude'])
  }
  assert.equal(aiterm.some(call => call.startsWith('antigravity')), false)
  // The body's HTTP edge adds the notice from the stored value.
  const api = createUsageApi({ onboarding: assembly.facade.onboarding, notify() {}, captureUsageContext: (_request, method) => owner(method) })
  const response = { writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body) } }
  await api({ method: 'GET', headers: {} }, response, new URL('http://fixture/api/setup'))
  assert.equal(response.body.harnessNotice, started ? RETIRED_HARNESS_NOTICE : undefined)
})

test('古いusageの部品が送る形を、新しい本体が受け入れて答える', async () => {
  const context = { generation: 'g', rootId: '1', kind: 'root', method: 'onboarding.status', mode: null, actor: { kind: 'system', botId: null }, continuation: false }
  // An older usage child asks sign-in status for a stored Antigravity choice before the guide conversation starts.
  const params = { harness: 'antigravity-cli', action: 'status' }
  assert.equal(usageEffectValid('auth.call', params, context), true)
  assert.equal(usageEffectValid('auth.call', { harness: 'gemini-cli', action: 'status' }, context), false)
  const aiterm = [], services = bodyServices('/unused', aiterm)
  const effects = createUsageParentEffects({ getServices: () => services, getFeatures: () => null, seatRuntime: null })
  const result = await effects('auth.call', params, context)
  assert.deepEqual(aiterm, [])
  // The older child reads the answer with these same two functions.
  const receipt = authReceipt(result, null, () => new Error('invalid'))
  assert.deepEqual([receipt.status, receipt.message, authUi(receipt, null).stage, authUi(receipt, null).message], ['failed', RETIRED_HARNESS_NOTICE, 'failed', RETIRED_HARNESS_NOTICE])
  // Its setup record names the stored value and still lists five AIs.
  const old = { phase: 'authenticate', harness: 'antigravity', harnesses: ['claude', 'codex', 'grok', 'cursor', 'antigravity'].map(id => ({ id, name: id })), guideBotId: 'bot-guide', complete: false,
    auth: { status: 'failed', url: null, user_code: null, input_required: false, message: RETIRED_HARNESS_NOTICE, session_id: null, auth_ui: authUi(receipt, null) } }
  assert.equal(usageResultValid('onboarding.status', old), true)
  // a399: from this body on an added field is read past (module-ipc.md); bodies before it refused the record, which is why a374 put the notice at the HTTP edge.
  assert.equal(usageResultValid('onboarding.status', { ...old, harnessNotice: RETIRED_HARNESS_NOTICE }), true)
})
