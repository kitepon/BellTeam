import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'

import { HarnessAuth } from '../src/harness-auth.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'

const receipt = value => ({ structuredContent: { schema: 'aiterm.agent-auth-result.v1', session_id: null, url: null, user_code: null, input_required: false, message: null, ...value } })

// Aitermの agent_auth の代わり。relogin を知っている版（true）と、引数を捨てる古い版（false）。
function aiterm({ relogin = true, official = 'authenticated' } = {}) {
  const calls = []
  const state = { official, session: null }
  return { calls, state, async call(name, args) {
    calls.push([name, args])
    if (name === 'pty_send' || name === 'pty_key') return { structuredContent: {} }
    if (name !== 'agent_auth') throw new Error(`unexpected ${name}`)
    if (args.action === 'cancel') { state.session = null; return receipt({ status: state.official }) }
    if (args.action === 'start') {
      if (state.official === 'authenticated' && !(relogin && args.relogin)) return receipt({ status: 'authenticated' })
      state.session = 'auth-1'
      state.official = 'waiting'
      return receipt({ status: 'waiting', session_id: 'auth-1', url: 'https://auth.example.com/device', user_code: 'ABCD-1234' })
    }
    return receipt({ status: state.official, ...(state.session ? { session_id: state.session } : {}) })
  } }
}

const bots = new Map([
  ['bot-a', { id: 'bot-a', harness: 'codex', project: '/srv/bellteam/bots/bot-a' }],
  ['bot-b', { id: 'bot-b', harness: 'codex', project: '/srv/bellteam/bots/bot-b' }],
  ['bot-c', { id: 'bot-c', harness: 'claude', project: '/srv/bellteam/bots/bot-c' }],
])

test('AIの種類と、それを使うメンバーの数を返す。公式の状態は見に行かない', () => {
  const client = aiterm()
  const { harnesses } = new HarnessAuth({ bots, client }).list()
  assert.deepEqual(harnesses.map(({ id, name, members }) => ({ id, name, members })), [
    { id: 'claude', name: 'Claude', members: 1 }, { id: 'codex', name: 'Codex', members: 2 },
    { id: 'grok', name: 'Grok', members: 0 }, { id: 'cursor', name: 'Cursor', members: 0 },
  ])
  // 始めた時点で今の認証が消えるAI（Codex）と、残るかを確かめられていないAI（Grok）には、始める前の知らせを付ける。
  assert.match(harnesses.find(item => item.id === 'codex').startWarning, /始めた時点で今の認証が消えます。途中でやめても元に戻りません。/u)
  assert.match(harnesses.find(item => item.id === 'grok').startWarning, /確かめられていません/u)
  assert.deepEqual(harnesses.filter(item => item.startWarning === null).map(item => item.id), ['claude', 'cursor'])
  assert.deepEqual(client.calls, [])
})

test('状態を見ただけの時は利用者向けの文を返し、認証が進行中の時はAitermの案内をそのまま返す', async () => {
  const jargon = 'Codexのログインの期限が切れています。agent_authのstartで入り直してください。'
  let next = { status: 'blocked', message: jargon }
  const client = { async call(name, args) {
    if (args.action === 'start') return receipt({ status: 'blocked', session_id: 'auth-1', input_required: true, message: '公式の画面で入力してください。' })
    return receipt(next)
  } }
  const auth = new HarnessAuth({ bots, client })
  const message = async harness => (await auth.status(harness)).auth.message
  assert.match(await message('codex'), /認証されていないか、認証の期限が切れています。「認証し直す」で公式サイトから入り直せます。/u)
  assert.equal((await message('codex')).includes('agent_auth'), false)
  next = { status: 'failed', message: 'Cursorのログインを確認できません…relogin:true…' }
  assert.match(await message('cursor'), /認証の状態を確かめられませんでした/u)
  assert.equal((await message('cursor')).includes('relogin'), false)
  // Claudeの公式CLIは期限切れでも認証済みと答えるので、そう見える時にだけ一言添える。
  next = { status: 'authenticated' }
  assert.match(await message('claude'), /期限切れを見分けられない事があります/u)
  assert.equal(await message('codex'), null)
  // 進行中は、公式の画面の案内を落とさない。
  assert.deepEqual((await auth.start('claude')).auth, { status: 'blocked', url: null, user_code: null, input_required: true, message: '公式の画面で入力してください。' })
  next = { status: 'blocked', session_id: 'auth-1', input_required: true, message: '公式の画面で入力してください。' }
  assert.equal(await message('claude'), '公式の画面で入力してください。')
})

test('認証済みに見えるAIでも入り直しを始め、通ったら認証の端末を閉じる', async () => {
  const client = aiterm()
  const auth = new HarnessAuth({ bots, client })

  assert.deepEqual(await auth.status('codex'), { harness: 'codex', auth: { status: 'authenticated', url: null, user_code: null, input_required: false, message: null } })
  const started = await auth.start('codex')
  assert.deepEqual(started, { harness: 'codex', auth: { status: 'waiting', url: 'https://auth.example.com/device', user_code: 'ABCD-1234', input_required: false, message: null } })
  assert.deepEqual(client.calls.at(-1), ['agent_auth', { harness: 'codex-cli', action: 'start', relogin: true, cwd: '/srv/bellteam/bots/bot-a' }])

  // 待っている間の確認は、同じ端末の状態を見る。
  assert.equal((await auth.status('codex')).auth.status, 'waiting')
  assert.deepEqual(client.calls.at(-1), ['agent_auth', { harness: 'codex-cli', action: 'status', session_id: 'auth-1', cwd: '/srv/bellteam/bots/bot-a' }])

  // 利用者が公式サイトで認証を済ませた。
  client.state.official = 'authenticated'
  assert.equal((await auth.status('codex')).auth.status, 'authenticated')
  assert.deepEqual(client.calls.slice(-2).map(call => call[1].action), ['status', 'cancel'])
  assert.equal(auth.sessions.has('codex'), false)
})

test('reloginを知らないAitermが何も始めなかった時は、認証済みと取り違えずに断る', async () => {
  const auth = new HarnessAuth({ bots, client: aiterm({ relogin: false }) })
  await assert.rejects(auth.start('codex'), error => error.code === 'HARNESS_AUTH_RELOGIN_UNSUPPORTED' && error.status === 409)
  assert.equal(auth.sessions.has('codex'), false)
})

test('認証が切れたAIは、古いAitermでも入り直しを始められる', async () => {
  const auth = new HarnessAuth({ bots, client: aiterm({ relogin: false, official: 'blocked' }) })
  assert.equal((await auth.start('grok')).auth.status, 'waiting')
})

test('認証の入力は進行中の端末へだけ送り、やめる時は端末を閉じる', async () => {
  const client = aiterm()
  const auth = new HarnessAuth({ bots, client })
  await assert.rejects(auth.input('codex', { text: 'x' }), error => error.code === 'HARNESS_AUTH_NOT_RUNNING')
  await auth.start('codex')
  await assert.rejects(auth.input('codex', { text: 'x', key: 'Enter' }), error => error.code === 'HARNESS_AUTH_INPUT_INVALID')
  await auth.input('codex', { text: 'secret' })
  assert.deepEqual(client.calls.at(-2), ['pty_send', { session_id: 'auth-1', text: 'secret', enter: true, raw: true }])
  await auth.input('codex', { key: 'Enter' })
  assert.deepEqual(client.calls.at(-2), ['pty_key', { session_id: 'auth-1', key: 'Enter' }])
  assert.deepEqual(await auth.cancel('codex'), { harness: 'codex', auth: null })
  assert.equal(client.calls.at(-1)[1].action, 'cancel')
  assert.equal(auth.sessions.has('codex'), false)
  await assert.rejects(auth.status('gpt'), error => error.code === 'HARNESS_AUTH_HARNESS_INVALID' && error.status === 400)
})

test('やり直しを押し直した時は、前の認証の端末を閉じてから始める', async () => {
  const client = aiterm()
  const auth = new HarnessAuth({ bots, client })
  await auth.start('codex')
  client.state.official = 'authenticated'
  await auth.start('codex')
  assert.deepEqual(client.calls.map(call => call[1].action), ['start', 'cancel', 'start'])
})

test('Aitermが値を省いた時も、無い値はnull、入力の要否は真偽で返す', async () => {
  const client = { async call() { return { structuredContent: { schema: 'aiterm.agent-auth-result.v1', status: 'blocked' } } } }
  assert.deepEqual(await new HarnessAuth({ bots, client }).status('cursor'), {
    harness: 'cursor', auth: { status: 'blocked', url: null, user_code: null, input_required: false, message: 'このAIは認証されていないか、認証の期限が切れています。「認証し直す」で公式サイトから入り直せます。' },
  })
})

test('Aitermの応答を読めない時は、認証済みとも未認証とも決めない', async () => {
  const auth = new HarnessAuth({ bots, client: { async call() { return { structuredContent: { schema: 'other' } } } } })
  await assert.rejects(auth.status('codex'), error => error.code === 'HARNESS_AUTH_RESPONSE_INVALID' && error.status === 502)
})

test('認証のやり直しのAPIは、認可の後で進行を渡し、失敗は理由の文つきで返す', async t => {
  const client = aiterm()
  let allowed = false
  const server = createBellTeamServer({ bots, authorize: () => allowed, harnessAuth: new HarnessAuth({ bots, client }) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}/api/harness-auth`
  assert.equal((await fetch(base)).status, 401)
  allowed = true

  assert.equal((await (await fetch(base)).json()).harnesses.find(item => item.id === 'codex').members, 2)
  assert.equal((await (await fetch(`${base}/codex`)).json()).auth.status, 'authenticated')
  const started = await fetch(`${base}/codex/start`, { method: 'POST' })
  assert.equal(started.status, 200)
  assert.equal((await started.json()).auth.user_code, 'ABCD-1234')
  const input = await fetch(`${base}/codex/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'Enter' }) })
  assert.equal(input.status, 200)
  assert.deepEqual(await (await fetch(`${base}/codex/cancel`, { method: 'POST' })).json(), { harness: 'codex', auth: null })

  const invalid = await fetch(`${base}/gpt`)
  assert.equal(invalid.status, 400)
  assert.deepEqual(await invalid.json(), { error: 'HARNESS_AUTH_HARNESS_INVALID', message: 'AIの種類を選んでください。' })
  assert.equal((await fetch(`${base}/codex/start`)).status, 405)
  assert.equal((await fetch(`${base}/codex/unknown`, { method: 'POST' })).status, 404)
})

test('認証のやり直しを持たないサーバーでは、その道は無い', async t => {
  const server = createBellTeamServer({ bots, authorize: () => true })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/harness-auth`)).status, 404)
})
