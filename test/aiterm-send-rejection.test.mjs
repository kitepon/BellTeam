import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AitermClient, AitermTransport } from '../src/aiterm-transport.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'
import { BellTeamMessenger } from '../src/messenger.mjs'

const refusal = "aiterm: agent session 'bot-a' の Codex TUI が入力受付状態になりません。文字列は送信していません。少し後で pty_read(screen:true) を確認し、TUI が起動済みなら再度 pty_send してください。"

// 同じ席への先の送信を待ち切れなかった時の断り（Aiterm 0.52.1）。持ち主が別プロセスの時と、同じプロセスの時で文面が違う。
const busy = "aiterm: AGENT_SEND_BUSY: agent session 'bot-a' は別プロセス（pid 4242）の処理中です。60000ms待っても順番が来ませんでした。文字列は送信していません。少し後で再度 pty_send してください。"
const busyInProcess = "aiterm: AGENT_SEND_BUSY: agent session 'bot-a' は先に受け付けた送信の処理中です。60000ms待っても順番が来ませんでした。文字列は送信していません。少し後で再度 pty_send してください。"

for (const [label, failure, status, code] of [
  ['0.48の入力受付拒否', refusal, 409, 'BOT_INPUT_NOT_READY'],
  ['0.49の確認画面による拒否', `${refusal}\nstate=blocked reason=hooks_review`, 409, 'BOT_INPUT_NOT_READY'],
  ['0.52.1の順番待ちの断り（別プロセス）', busy, 409, 'BOT_SEND_BUSY'],
  ['0.52.1の順番待ちの断り（同じプロセス）', busyInProcess, 409, 'BOT_SEND_BUSY'],
  ['それ以外のAiterm障害', 'aiterm: PTY_BACKEND_FAILED', 500, 'INTERNAL_ERROR'],
]) {
  test(`${label}は未配送を保持し、APIで入力受付拒否とサーバー障害を区別する`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'bellteam-send-rejection-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const calls = []
    const client = new AitermClient()
    client.client = { async callTool({ name }) {
      calls.push(name)
      if (name === 'pty_send') return { isError: true, content: [{ type: 'text', text: failure }] }
      if (name === 'pty_list') return { content: [{ type: 'text', text: 'bot-a\tcodex' }] }
      throw new Error(`unexpected tool: ${name}`)
    } }
    const bot = { id: 'bot-a', session: 'bot-a', harness: 'codex', project: root }
    const bots = new Map([[bot.id, bot]])
    const transport = new AitermTransport({ client })
    const messenger = new BellTeamMessenger({ bots, transport, logPath: join(root, 'messages.jsonl') })
    const diagnostics = []
    const server = createBellTeamServer({
      bots, transport, messenger, store: messenger.store, authorize: async () => true,
      diagnostics: { async record(value) { diagnostics.push(value) } },
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(() => new Promise(resolve => server.close(resolve)))
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bots/bot-a/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '再現用の本文' }),
    })
    assert.equal(response.status, status)
    const body = await response.json()
    assert.equal(body.error, code)
    if (status === 409) {
      assert.match(body.message, /送信されませんでした/u)
      assert.equal(body.message.includes('pty_'), false)
    }
    assert.deepEqual(calls, ['pty_send', 'pty_list'])
    await transport.idle(bot.id)
    const records = await messenger.store.records()
    assert.equal(records.length, 1)
    assert.equal(records[0].message, '再現用の本文')
    assert.equal(records[0].delivery, 'failed')
    assert.equal(transport.active.size, 0)
    assert.deepEqual(diagnostics.map(value => value.code), status === 409 ? [] : ['SERVER_HTTP_500'])
  })
}

test('入力拒否の分類は該当するpty_sendだけに限定し、元の理由を保持する', async () => {
  const client = new AitermClient()
  client.client = { async callTool() {
    return { isError: true, content: [{ type: 'text', text: `${refusal}\nstate=blocked reason=hooks_review` }] }
  } }
  await assert.rejects(client.call('pty_send', { session_id: 'bot-a', text: '本文' }), error => {
    assert.equal(error.status, 409)
    assert.equal(error.code, 'BOT_INPUT_NOT_READY')
    assert.match(error.message, /state=blocked reason=hooks_review/u)
    return true
  })
  await assert.rejects(client.call('pty_send', { session_id: 'bot-b', text: '本文' }), error => error.status === undefined)
  await assert.rejects(client.call('pty_read', { session_id: 'bot-a' }), error => error.status === undefined)
})

test('順番待ちの断りの分類は該当する席へのpty_sendだけに限定し、元の理由を保持する', async () => {
  const client = new AitermClient()
  client.client = { async callTool() { return { isError: true, content: [{ type: 'text', text: busy }] } } }
  await assert.rejects(client.call('pty_send', { session_id: 'bot-a', text: '本文' }), error => {
    assert.equal(error.status, 409)
    assert.equal(error.code, 'BOT_SEND_BUSY')
    assert.match(error.message, /pid 4242/u)
    assert.equal(error.publicMessage.includes('pty_'), false)
    return true
  })
  await assert.rejects(client.call('pty_send', { session_id: 'bot-b', text: '本文' }), error => error.status === undefined)
  await assert.rejects(client.call('agent_launch', { session_id: 'bot-a' }), error => error.status === undefined)
  // 「送信していません」が無い文は、打った後かもしれないので分類しない。
  client.client = { async callTool() {
    return { isError: true, content: [{ type: 'text', text: "aiterm: AGENT_SEND_BUSY: agent session 'bot-a' は別プロセス（pid 4242）の処理中です。" }] }
  } }
  await assert.rejects(client.call('pty_send', { session_id: 'bot-a', text: '本文' }), error => error.status === undefined)
})

const unregistered = "aiterm: AGENT_SESSION_REQUIRED: session 'bot-a' のagent登録がありません。文字列は送信していません。"

// sessions はpty_listが返す画面。登録だけ消えた席は画面が残り、止まっている席は画面も無い。
function registrationLostClient({ refusals, sessions = 'bot-a\tclaude' }) {
  const calls = []
  let sends = 0
  // 断りの分類は本物のAitermClientを通す。起動用の環境は渡さず、実物のAitermを立てない。
  const classifier = new AitermClient()
  const client = { call: (name, args) => classifier.call(name, args) }
  classifier.client = { async callTool({ name, arguments: args }) {
    calls.push([name, args])
    if (name === 'pty_send' && ++sends <= refusals) return { isError: true, content: [{ type: 'text', text: unregistered }] }
    if (name === 'pty_send') return { structuredContent: {
      mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: '/node', args: ['wait'] },
    } }
    if (name === 'pty_list') return { content: [{ type: 'text', text: sessions }] }
    if (name === 'pty_close') return { content: [{ type: 'text', text: 'closed' }] }
    if (name === 'agent_launch') return { structuredContent: { session_id: 'bot-a' } }
    if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: '了解' } }
    throw new Error(`unexpected tool: ${name}`)
  } }
  return { client, calls }
}

test('席の登録が消えて打つ前に断られた送信は、席を閉じて起こし直し、同じ文を1回だけ送る', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-registration-lost-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { client, calls } = registrationLostClient({ refusals: 1 })
  const transport = new AitermTransport({ client, handoffContext: async () => '', waitProcess: async () => ({ outcome: 'done' }) })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'claude', project: root }

  await transport.turn(bot, '再現用の本文')

  assert.deepEqual(calls.map(([name]) => name), ['pty_send', 'pty_list', 'pty_close', 'agent_launch', 'pty_send', 'pty_read'])
  assert.deepEqual(calls[2][1], { session_id: 'bot-a' })
  assert.deepEqual(calls.filter(([name]) => name === 'pty_send').map(([, args]) => args), [
    { session_id: 'bot-a', text: '再現用の本文', require_agent: true },
    { session_id: 'bot-a', text: '再現用の本文', require_agent: true },
  ])
})

test('起こし直した後も登録が無ければ、もう一度は起こし直さず失敗にする', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-registration-lost-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { client, calls } = registrationLostClient({ refusals: 2 })
  const transport = new AitermTransport({ client, handoffContext: async () => '' })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'claude', project: root }

  await assert.rejects(transport.turn(bot, '再現用の本文'), /AGENT_SESSION_REQUIRED/u)

  assert.deepEqual(calls.map(([name]) => name), ['pty_send', 'pty_list', 'pty_close', 'agent_launch', 'pty_send'])
  assert.equal(transport.active.size, 0)
})

test('画面が無い席が同じ符号で断られた時は、登録の消失として扱わず、閉じずに起こして送る', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-registration-lost-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { client, calls } = registrationLostClient({ refusals: 1, sessions: '' })
  const transport = new AitermTransport({ client, handoffContext: async () => '', waitProcess: async () => ({ outcome: 'done' }) })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'claude', project: root }
  const written = []
  t.mock.method(process.stderr, 'write', text => { written.push(String(text)); return true })

  await transport.turn(bot, '再現用の本文')

  assert.deepEqual(calls.map(([name]) => name), ['pty_send', 'pty_list', 'agent_launch', 'pty_send', 'pty_read'])
  assert.deepEqual(written.filter(text => text.includes('registration lost')), [])
})

test('打った後に返るmode=sentは、送り直さず無効な受け取りとして失敗にする', async () => {
  const calls = []
  const transport = new AitermTransport({
    client: { async call(name) {
      calls.push(name)
      if (name === 'pty_send') return { structuredContent: { mode: 'sent', event_cursor: null, wait_process: null } }
      throw new Error(`unexpected ${name}`)
    } },
    handoffContext: async () => '',
  })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'claude', project: '/bots/bot-a' }

  await assert.rejects(transport.turn(bot, '再現用の本文'), /AITERM_DISPATCH_RECEIPT_INVALID: bot-a/u)

  assert.deepEqual(calls, ['pty_send'])
})

test('登録なしの分類は、打つ前に断ったpty_sendだけに限定する', async () => {
  const client = new AitermClient()
  let text = unregistered
  client.client = { async callTool() { return { isError: true, content: [{ type: 'text', text }] } } }
  await assert.rejects(client.call('pty_send', { session_id: 'bot-a', text: '本文' }), error => error.code === 'AGENT_SESSION_REQUIRED' && error.status === undefined)
  await assert.rejects(client.call('pty_read', { session_id: 'bot-a' }), error => error.code === undefined)
  text = 'aiterm: AGENT_SESSION_REQUIRED: 理由不明'
  await assert.rejects(client.call('pty_send', { session_id: 'bot-a', text: '本文' }), error => error.code === undefined)
})

// Aiterm 0.52.0のClaude席の振り分けをなぞる。印が無ければ新しいターンとして入力受付を待ち、待った後で印を取る。
// 待っている間に別の送信が印を取ると、後から印を取りに来た方を断る。
function wakingClaudeClient() {
  const calls = []
  let launched = false
  let marker = false
  const tick = () => new Promise(resolve => setTimeout(resolve, 5))
  const classifier = new AitermClient()
  const client = { call: (name, args) => classifier.call(name, args) }
  classifier.client = { async callTool({ name, arguments: args }) {
    calls.push([name, args])
    if (name === 'pty_list') return { content: [{ type: 'text', text: launched ? 'bot-a\tclaude' : '' }] }
    if (name === 'agent_launch') { await tick(); launched = true; return { structuredContent: { session_id: 'bot-a' } } }
    if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: '了解' } }
    if (name !== 'pty_send') throw new Error(`unexpected tool: ${name}`)
    if (!launched) return { isError: true, content: [{ type: 'text', text: unregistered }] }
    if (marker) return { structuredContent: { mode: 'agent_steer', event_cursor: null, wait_process: null } }
    await tick()
    if (marker) return { isError: true, content: [{ type: 'text', text: 'aiterm: operation_idなしのClaude turn が未解決です。Stop結果を回収するかsessionをcloseするまで次のturnを送れません。' }] }
    marker = true
    return { structuredContent: { mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: '/node', args: ['wait'] } } }
  } }
  return { client, calls }
}

test('起こしている途中の席へ次の文が重なっても、前の送信が受け付けられてから送り、差し込みにする', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-overlapping-send-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { client, calls } = wakingClaudeClient()
  let finish
  const done = new Promise(resolve => { finish = resolve })
  const transport = new AitermTransport({ client, handoffContext: async () => '', waitProcess: async () => { await done; return { outcome: 'done' } } })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'claude', project: root }

  const first = transport.notify(bot, '1通目')
  const second = transport.notify(bot, '2通目')

  assert.deepEqual(await first, { delivery: 'running' })
  assert.deepEqual(await second, { delivery: 'steered' })
  finish()
  await transport.idle(bot.id)
  assert.deepEqual(calls.filter(([name]) => name === 'agent_launch').length, 1)
  assert.deepEqual(calls.filter(([name]) => name === 'pty_send').map(([, args]) => args.text), ['1通目', '1通目', '2通目'])
})

test('前の送信が失敗しても、同じ席への次の送信は止めない', async () => {
  let sends = 0
  const transport = new AitermTransport({
    client: { async call(name) {
      if (name === 'pty_list') return { content: [{ type: 'text', text: 'bot-a\tclaude' }] }
      if (name !== 'pty_send') throw new Error(`unexpected ${name}`)
      if (++sends === 1) throw new Error('aiterm: PTY_BACKEND_FAILED')
      return { structuredContent: { mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: '/node', args: ['wait'] } } }
    } },
    handoffContext: async () => '', waitProcess: async () => ({ outcome: 'done' }),
  })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'claude', project: '/bots/bot-a' }

  const first = transport.notify(bot, '1通目')
  const second = transport.notify(bot, '2通目')

  await assert.rejects(first, /PTY_BACKEND_FAILED/u)
  assert.deepEqual(await second, { delivery: 'running' })
  await transport.idle(bot.id)
  assert.equal(transport.dispatches.size, 0)
})
