import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BotRegistry } from '../src/bot-registry.mjs'
import { Onboarding, GUIDE_BOT_ID } from '../src/onboarding.mjs'
import { Subscriptions } from '../src/subscriptions.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-onboarding-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const seedPath = join(root, 'bots.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [] }))
  const bots = new BotRegistry({ seedPath, botsRoot: join(root, 'bots') })
  await bots.initialize()
  const subscriptions = new Subscriptions({ path: join(root, 'shared/subscription.json') })
  await subscriptions.initialize()
  const calls = [], conversations = []
  let status = 'waiting'
  const client = { async call(name, args) {
    calls.push({ name, args })
    if (name !== 'agent_auth') return {}
    return { structuredContent: { schema: 'aiterm.agent-auth-result.v1', harness: args.harness,
      status, session_id: 'auth-session', url: status === 'waiting' ? 'https://example.com/login' : null,
      user_code: status === 'waiting' ? 'TEST-CODE' : null, input_required: false, message: null } }
  } }
  const options = { root, bots, client, subscriptions, startConversation: async (bot, message) => conversations.push({ bot, message }) }
  const onboarding = new Onboarding(options)
  await onboarding.initialize()
  return { onboarding, bots, subscriptions, calls, conversations, options, authenticate: () => { status = 'authenticated' } }
}

test('空の環境ではハーネスだけを選び、公式認証を確かめてから案内役が会話を始める', async t => {
  const f = await fixture(t)
  assert.equal(f.onboarding.snapshot().phase, 'select_harness')
  assert.equal(f.bots.size, 0)
  const selected = await f.onboarding.select('codex')
  assert.equal(selected.phase, 'authenticate')
  assert.equal(selected.guideBotId, GUIDE_BOT_ID)
  assert.equal(f.bots.get(GUIDE_BOT_ID).harness, 'codex')
  assert.equal(selected.auth.user_code, 'TEST-CODE')
  assert.equal(selected.auth.session_id, 'auth-session')
  assert.equal(selected.auth.auth_ui.stage, 'unavailable')
  await assert.rejects(f.onboarding.input({ key: 'Enter' }), { code: 'AUTH_RESPONSE_INVALID' })
  assert.equal(f.calls.some(({ name }) => name === 'pty_key' || name === 'pty_send'), false)
  await assert.rejects(f.onboarding.start(), { code: 'SETUP_AUTH_REQUIRED' })
  assert.equal(f.conversations.length, 0)
  f.authenticate()
  assert.equal((await f.onboarding.start()).phase, 'ready')
  assert.equal(f.conversations.length, 1)
  assert.match(f.conversations[0].message, /get_settings/u)
  await f.onboarding.start()
  assert.equal(f.conversations.length, 1)
  await f.bots.prepareStartupContext(GUIDE_BOT_ID, '')
  await f.onboarding.prepareStartup(f.bots.get(GUIDE_BOT_ID))
  assert.match(await readFile(join(f.bots.get(GUIDE_BOT_ID).project, 'AGENTS.md'), 'utf8'), /complete_setup/u)
})

test('再起動後も公式認証の相関を使い、ハーネス変更では前の認証端末を閉じる', async t => {
  const f = await fixture(t)
  await f.onboarding.select('codex')
  const resumed = new Onboarding(f.options)
  await resumed.initialize()
  assert.equal((await resumed.status()).auth.status, 'waiting')
  assert.equal(f.calls.at(-1).args.session_id, 'auth-session')
  await resumed.select('grok')
  assert.equal(f.calls.at(-2).args.action, 'cancel')
  assert.equal(f.calls.at(-1).args.harness, 'grok-cli')
  assert.equal(f.bots.size, 1)
})

test('Antigravityの初回認証は公式harnessへ渡し強制reloginを要求しない', async t => {
  const f = await fixture(t)
  const selected = await f.onboarding.select('antigravity')
  assert.equal(selected.harness, 'antigravity')
  assert.equal(f.bots.get(GUIDE_BOT_ID).harness, 'antigravity')
  assert.equal(f.calls.at(-1).args.harness, 'antigravity-cli')
  assert.equal(f.calls.at(-1).args.relogin, undefined)
  f.authenticate()
  await f.onboarding.start()
  assert.equal(f.conversations[0].bot.harness, 'antigravity')
})

test('案内役は購入前に初期設定を完了でき、Web無料とApple購読を案内する', async t => {
  const f = await fixture(t)
  await f.onboarding.select('claude')
  await assert.rejects(f.onboarding.complete(), { code: 'SETUP_GUIDE_REQUIRED' })
  f.authenticate()
  await f.onboarding.start()
  await assert.rejects(f.onboarding.complete('bot-other'), { code: 'SETUP_GUIDE_REQUIRED' })
  await f.onboarding.complete(GUIDE_BOT_ID)
  assert.equal(f.subscriptions.status().setupComplete, true)
  assert.equal(f.subscriptions.status().canUseAI, true)
  assert.equal(f.subscriptions.status().entitled, false)
  assert.match(f.conversations[0].message, /Webアプリ.*無料/u)
  assert.match(f.conversations[0].message, /初期設定後のAppleアプリからの会話と予定操作には購読が必要/u)
  const resumed = new Onboarding(f.options)
  await resumed.initialize()
  assert.equal(resumed.snapshot().complete, true)
})

test('既存のBotがある環境は初期設定へ戻さない', async t => {
  const f = await fixture(t)
  await f.bots.create({ name: '既存', harness: 'codex' })
  await rm(f.onboarding.path)
  const resumed = new Onboarding(f.options)
  await resumed.initialize()
  assert.equal(resumed.snapshot().phase, 'ready')
  assert.equal(resumed.snapshot().complete, true)
  assert.equal(resumed.snapshot().guideBotId, null)
})

test('認証ツールの異常な応答は成功扱いにしない', async t => {
  const f = await fixture(t)
  f.options.client.call = async () => ({ structuredContent: { status: 'authenticated' } })
  await assert.rejects(f.onboarding.select('cursor'), { code: 'SETUP_AUTH_RESPONSE_INVALID' })
  assert.equal(f.onboarding.snapshot().phase, 'authenticate')
  assert.equal(f.conversations.length, 0)
})

test('認証確認中のハーネス変更は前の応答を待ち、新しい認証端末だけを保存する', async t => {
  const f = await fixture(t)
  await f.onboarding.select('claude')
  const calls = []
  let finishStatus
  const oldStatus = new Promise(resolve => { finishStatus = resolve })
  f.options.client.call = async (name, args) => {
    calls.push({ name, args })
    if (args.action === 'status') return oldStatus
    return { structuredContent: { schema: 'aiterm.agent-auth-result.v1', harness: args.harness,
      status: 'waiting', session_id: args.action === 'start' ? 'new-auth-session' : 'auth-session',
      url: null, user_code: null, input_required: false, message: null } }
  }
  const checking = f.onboarding.status()
  await new Promise(resolve => setImmediate(resolve))
  const selecting = f.onboarding.select('grok')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls.map(call => call.args.action), ['status'])
  finishStatus({ structuredContent: { schema: 'aiterm.agent-auth-result.v1', harness: 'claude-code',
    status: 'waiting', session_id: 'auth-session', url: null, user_code: null, input_required: false, message: null } })
  await Promise.all([checking, selecting])
  assert.equal(f.onboarding.state.harness, 'grok')
  assert.equal(f.onboarding.state.authSession, 'new-auth-session')
  assert.equal(f.onboarding.auth.harness, 'grok-cli')
  const saved = JSON.parse(await readFile(f.onboarding.path, 'utf8'))
  assert.equal(saved.harness, 'grok')
  assert.equal(saved.authSession, 'new-auth-session')
})

test('初期設定のコードも同じ専用respondへ一回だけ送り、設定ファイルに値を残さない', async t => {
  const f = await fixture(t)
  const binding = { session_id: 'auth-session', launch_id: null, metadata_identity: 'dev:ino:birth:mtime',
    native_id: 'own-native', pane_id: '%1', server_pid: 100, server_started: 'birth-server', pane_pid: 101, pane_started: 'birth-pane' }
  f.options.client.call = async (name, args) => {
    f.calls.push({ name, args })
    assert.equal(name, 'agent_auth')
    return { structuredContent: { schema: 'aiterm.agent-auth-result.v1', status: args.action === 'respond' ? 'authenticated' : 'waiting', session_id: 'auth-session',
      auth_ui: { schema: 'aiterm.auth-ui.v1', stage: args.action === 'respond' ? 'complete' : 'paste_code', title: '公式ログイン', message: '公式ページでログインしてください。',
        binding, prompt_digest: 'a'.repeat(64), url: 'https://claude.com/cai/oauth/authorize?code=true', user_code: null, input: 'authorization_code', choices: [] } } }
  }
  await f.onboarding.select('claude')
  const result = await f.onboarding.input({ binding, prompt_digest: 'a'.repeat(64), response: { kind: 'authorization_code', value: 'synthetic-code-never-store' } })
  assert.equal(result.auth.status, 'authenticated')
  assert.equal(f.calls.filter(call => call.args.action === 'respond').length, 1)
  assert.equal((await readFile(f.onboarding.path, 'utf8')).includes('synthetic-code-never-store'), false)
})
