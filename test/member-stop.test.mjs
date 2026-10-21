import assert from 'node:assert/strict'
import { once } from 'node:events'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'
import { ConversationStore } from '../src/conversation-store.mjs'
import { requestMemberStop } from '../web/member-stop.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function fixture(t, { onSend = null, onClose = null, observation = null } = {}) {
  const project = await mkdtemp(join(tmpdir(), 'bellteam-stop-'))
  t.after(() => rm(project, { recursive: true, force: true }))
  const bots = ['a', 'b'].map(name => ({ id: `bot-${name}`, session: `old-${name}`, harness: 'codex', project }))
  const alive = new Set(bots.map(bot => bot.session))
  const calls = [], sent = [], waits = new Map()
  let sequence = 0
  const client = { async call(name, args) {
    calls.push([name, args])
    if (name === 'pty_send') {
      if (!alive.has(args.session_id)) throw new Error('SESSION_NOT_FOUND')
      sent.push(args.text)
      await onSend?.(args)
      return { structuredContent: { mode: 'agent_dispatch', event_cursor: ++sequence,
        wait_process: { executable: 'synthetic-wait', args: [String(sequence)] } } }
    }
    if (name === 'pty_list') return { content: [{ type: 'text', text: [...alive].map(id => `${id}\tAI`).join('\n') }] }
    if (name === 'pty_observe') return { structuredContent: observation ? observation(args, alive) : {
      schema: 'aiterm.pty-observe-result.v1', session_id: args.session_id, exists: alive.has(args.session_id),
    } }
    if (name === 'pty_close') {
      await onClose?.(args, alive)
      alive.delete(args.session_id)
      return { structuredContent: { schema: 'aiterm.pty-close-result.v1', outcome: 'closed' } }
    }
    if (name === 'agent_launch') { alive.add(args.session_name); return { structuredContent: { session_id: args.session_name } } }
    if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: '回答' } }
    throw new Error(`unexpected ${name}`)
  } }
  const transport = new AitermTransport({ client, handoffContext: async () => '', waitProcess: (receipt, signal) => {
    const wait = deferred()
    waits.set(receipt.args[0], wait)
    signal?.addEventListener('abort', () => wait.reject(new Error('synthetic abort')), { once: true })
    return wait.promise
  } })
  t.after(() => { for (const wait of waits.values()) wait.resolve({ outcome: 'done' }) })
  const start = (bot, message, options) => {
    const completion = transport.turn(bot, message, options)
    return { completion, result: completion.catch(error => error) }
  }
  return { bots, alive, calls, sent, waits, transport, start }
}

test('停止は対象の作業完了を待たずに閉じ、同席の配送を停止として整理し、他席は続ける', { timeout: 2000 }, async t => {
  const f = await fixture(t)
  const statuses = []
  const a = f.start(f.bots[0], '最初', { onStatus: status => statuses.push(status) })
  await a.completion.accepted
  const a2 = f.start(f.bots[0], '同席の次')
  const b = f.start(f.bots[1], '別席')
  await Promise.all([a2.completion.accepted, b.completion.accepted])
  assert.deepEqual(await f.transport.interrupt(f.bots[0]), { botId: 'bot-a', status: 'stopped', online: false })
  assert.equal((await a.result).code, 'BOT_STOPPED')
  assert.equal((await a2.result).code, 'BOT_STOPPED')
  assert.deepEqual(statuses, ['running', 'stopped'])
  assert.equal(f.alive.has('old-a'), false)
  assert.equal(f.alive.has('old-b'), true)
  assert.deepEqual(f.transport.queueItems().map(item => item.botId), ['bot-b'])
  f.waits.get('3').resolve({ outcome: 'done' })
  assert.equal(await b.result, '回答')
  assert.equal(f.calls.filter(([name]) => name === 'agent_launch').length, 0)
})

test('旧送信の後着を確定してから閉じ、未送信の旧文を送らず、新しい文は閉鎖後に起動する', { timeout: 2000 }, async t => {
  const sending = deferred(), entered = deferred()
  let first = true
  const f = await fixture(t, { onSend: async () => { if (first) { first = false; entered.resolve(); await sending.promise } } })
  const old = f.start(f.bots[0], '送信中')
  await entered.promise
  const queued = f.start(f.bots[0], '未送信')
  await tick()
  const stopping = f.transport.interrupt(f.bots[0])
  assert.equal(f.transport.interrupt(f.bots[0]), stopping)
  const next = f.start(f.bots[0], '新しい文')
  await tick()
  assert.equal(f.calls.some(([name]) => name === 'pty_close'), false)
  sending.resolve()
  await stopping
  assert.equal((await old.result).code, 'BOT_STOPPED')
  assert.equal((await queued.result).code, 'BOT_STOPPED')
  await next.completion.accepted
  assert.deepEqual(f.sent, ['送信中', '新しい文'])
  assert.equal(f.calls.filter(([name]) => name === 'pty_close').length, 1)
  assert.equal(f.calls.filter(([name]) => name === 'agent_launch').length, 1)
  f.waits.get('2').resolve({ outcome: 'done' })
  assert.equal(await next.result, '回答')
})

test('起動中の古い配送は、起動応答の後に本文を送らず閉じる', { timeout: 2000 }, async t => {
  const f = await fixture(t)
  f.alive.delete('old-a')
  const launch = deferred(), entered = deferred()
  const call = f.transport.client.call
  f.transport.client.call = async (name, args) => {
    if (name === 'agent_launch') { entered.resolve(); await launch.promise }
    return call(name, args)
  }
  const old = f.start(f.bots[0], '起動中の文')
  await entered.promise
  const stopping = f.transport.interrupt(f.bots[0])
  launch.resolve()
  await stopping
  assert.equal((await old.result).code, 'BOT_STOPPED')
  assert.deepEqual(f.sent, [])
  assert.equal(f.alive.has('bot-a'), false)
})

test('doneが閉鎖中に後着しても回答や配達済みを追加しない', { timeout: 2000 }, async t => {
  const entered = deferred(), close = deferred()
  const f = await fixture(t, { onClose: async () => { entered.resolve(); await close.promise } })
  const statuses = []
  const old = f.start(f.bots[0], '動作中', { onStatus: status => statuses.push(status) })
  await old.completion.accepted
  const stopping = f.transport.interrupt(f.bots[0])
  await entered.promise
  f.waits.get('1').resolve({ outcome: 'done' })
  await tick()
  assert.equal(f.calls.some(([name]) => name === 'pty_read'), false)
  close.resolve()
  await stopping
  assert.equal((await old.result).code, 'BOT_STOPPED')
  assert.deepEqual(statuses, ['running', 'stopped'])
})

test('close拒否時は停止とせず、受理済みターンの通常完了を追う', { timeout: 2000 }, async t => {
  const f = await fixture(t, { onClose: () => { throw new Error('SEND_LOCK_BUSY') } })
  const statuses = []
  const old = f.start(f.bots[0], '継続中', { onStatus: status => statuses.push(status) })
  await old.completion.accepted
  await assert.rejects(f.transport.interrupt(f.bots[0]), error => error.code === 'BOT_STOP_UNCONFIRMED')
  assert.equal(f.alive.has('old-a'), true)
  f.waits.get('1').resolve({ outcome: 'done' })
  assert.equal(await old.result, '回答')
  assert.deepEqual(statuses, ['running', 'delivered'])
})

test('消失を確認できない観測・違う席の観測は停止成功にしない', async t => {
  for (const mode of ['still-exists', 'malformed', 'wrong-session', 'unavailable']) await t.test(mode, async t => {
    const f = await fixture(t, { observation: (args, alive) => {
      if (!alive.has(args.session_id)) {
        if (mode === 'malformed') return { exists: false }
        if (mode === 'wrong-session') return { schema: 'aiterm.pty-observe-result.v1', session_id: 'other', exists: false }
        if (mode === 'unavailable') throw new Error('OBSERVE_FAILED')
        return { schema: 'aiterm.pty-observe-result.v1', session_id: args.session_id, exists: true }
      }
      return { schema: 'aiterm.pty-observe-result.v1', session_id: args.session_id, exists: true }
    } })
    await assert.rejects(f.transport.interrupt(f.bots[0]), error => error.code === 'BOT_STOP_UNCONFIRMED')
  })
})

test('既に無い席の停止は起動せず成功し、停止前から待っていた再起動は復活させない', { timeout: 2000 }, async t => {
  const f = await fixture(t)
  const old = f.start(f.bots[0], '動作中')
  await old.completion.accepted
  const restarting = f.transport.restart(f.bots[0]).catch(error => error)
  await f.transport.interrupt(f.bots[0])
  assert.equal((await old.result).code, 'BOT_STOPPED')
  assert.equal((await restarting).code, 'BOT_STOPPED')
  await f.transport.interrupt(f.bots[0])
  assert.equal(f.calls.filter(([name]) => name === 'pty_close').length, 1)
  assert.equal(f.calls.filter(([name]) => name === 'agent_launch').length, 0)
})

test('停止前のensureと席一覧の遅い観測から、閉じた席を起こしたり再追跡したりしない', async t => {
  const f = await fixture(t)
  const query = deferred(), entered = deferred()
  const call = f.transport.client.call
  f.transport.client.call = async (name, args, options) => {
    if (name === 'pty_list') { entered.resolve(); return query.promise }
    return call(name, args, options)
  }
  const ensuring = f.transport.ensure(f.bots[0]).catch(error => error)
  const watching = f.transport.watchSeatTurns(f.bots)
  await entered.promise
  await f.transport.interrupt(f.bots[0])
  query.resolve({ content: [{ type: 'text', text: '' }], _meta: { 'aiterm/seat_turns': {
    schema: 'aiterm.seat-turns.v1', seats: [{ session_id: 'old-a', turn: {
      state: 'running', turn_id: 'stale', wait_process: { executable: 'synthetic', args: ['stale'] },
    } }],
  } } })
  assert.equal((await ensuring).code, 'BOT_STOPPED')
  await watching
  assert.equal(f.transport.queueItems().length, 0)
  assert.equal(f.calls.some(([name]) => name === 'agent_launch'), false)
})

test('停止より前に読み始めた回答の後着を、新しい回答として出さない', { timeout: 2000 }, async t => {
  const f = await fixture(t)
  const reading = deferred(), answer = deferred()
  const call = f.transport.client.call
  f.transport.client.call = async (name, args, options) => {
    if (name === 'pty_read') { reading.resolve(); await answer.promise }
    return call(name, args, options)
  }
  const old = f.start(f.bots[0], '動作中')
  await old.completion.accepted
  f.waits.get('1').resolve({ outcome: 'done' })
  await reading.promise
  const stopping = f.transport.interrupt(f.bots[0])
  await tick()
  assert.equal(f.alive.has('old-a'), false)
  answer.resolve()
  await stopping
  assert.equal((await old.result).code, 'BOT_STOPPED')
})

test('4ハーネスとも同じ停止口で対象の席だけを閉じる', async t => {
  for (const harness of ['claude', 'codex', 'grok', 'cursor']) await t.test(harness, async t => {
    const f = await fixture(t)
    f.bots[0].harness = harness
    const old = f.start(f.bots[0], '合成作業')
    await old.completion.accepted
    await f.transport.interrupt(f.bots[0])
    assert.equal((await old.result).code, 'BOT_STOPPED')
    assert.equal(f.alive.has('old-b'), true)
  })
})

test('自分から動いたターンの見張りも対象の停止後に外す', { timeout: 2000 }, async t => {
  const f = await fixture(t)
  f.transport.watchTurn(f.bots[0], 'old-a', { turn_id: 'self', wait_process: { executable: 'synthetic', args: ['self'] } }, { groupId: () => 'group' })
  await f.transport.interrupt(f.bots[0])
  assert.equal(f.transport.queueItems().length, 0)
  assert.equal(f.transport.watches.size, 0)
})

test('停止APIは認証後に対象だけを止め、完了前に200を返さず、失敗を502にする', async t => {
  const bot = { id: 'bot-a' }, calls = [], gate = deferred(), entered = deferred()
  let fail = false
  const server = createBellTeamServer({ bots: new Map([[bot.id, bot]]), authorize: request => request.headers.authorization === 'Bearer synthetic',
    transport: { async interrupt(value) { calls.push(value.id); if (fail) throw new Error('unknown'); entered.resolve(); await gate.promise; return { botId: value.id, status: 'stopped', online: false } } } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}/api/bots`, headers = { authorization: 'Bearer synthetic' }
  assert.equal((await fetch(`${base}/bot-a/stop`, { method: 'POST' })).status, 401)
  assert.equal((await fetch(`${base}/missing/stop`, { method: 'POST', headers })).status, 404)
  assert.equal((await fetch(`${base}/bot-a/stop`, { headers })).status, 405)
  assert.deepEqual(calls, [])
  let finished = false
  const pending = fetch(`${base}/bot-a/stop`, { method: 'POST', headers }).then(value => { finished = true; return value })
  await entered.promise; assert.equal(finished, false)
  gate.resolve()
  const response = await pending
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { botId: 'bot-a', status: 'stopped', online: false })
  fail = true
  const failed = await fetch(`${base}/bot-a/stop`, { method: 'POST', headers })
  assert.equal(failed.status, 502)
  assert.equal((await failed.json()).error, 'BOT_STOP_UNCONFIRMED')
  assert.deepEqual(calls, ['bot-a', 'bot-a'])
})

test('停止状態は会話を消さず、再読込したタイムラインにも残る', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-stopped-log-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const logPath = join(root, 'messages.jsonl')
  await writeFile(logPath, JSON.stringify({ schema: 'bellteam.direct-message.v1', delivery_id: 'a', from: 'user', target: 'bot-a', message: '作業', delivery: 'running' }) + '\n')
  await appendFile(logPath, JSON.stringify({ schema: 'bellteam.delivery-status.v1', delivery_id: 'a', delivery: 'stopped' }) + '\n')
  assert.deepEqual((await new ConversationStore({ logPath }).timeline('bot-a')).map(item => [item.message, item.delivery]), [['作業', 'stopped']])
})

test('Webは対象ID付きの停止確認だけを成功とし、不明な結果を再送しない', async () => {
  for (const result of [{ botId: 'other', status: 'stopped', online: false }, { botId: 'bot-a', status: 'stopping', online: false }, { botId: 'bot-a', status: 'stopped', online: true }, null]) {
    const calls = []
    await assert.rejects(requestMemberStop('bot-a', async (...args) => { calls.push(args); return result }), /確認できません/u)
    assert.deepEqual(calls, [['/api/bots/bot-a/stop', { method: 'POST' }]])
  }
  let calls = 0
  await assert.rejects(requestMemberStop('bot-a', async () => { calls++; throw new Error('connection lost') }))
  assert.equal(calls, 1)
  const result = { botId: 'bot-a', status: 'stopped', online: false }
  assert.equal(await requestMemberStop('bot-a', async () => result), result)
})
