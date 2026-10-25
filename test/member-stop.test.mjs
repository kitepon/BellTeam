import assert from 'node:assert/strict'
import { once } from 'node:events'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AitermClient, AitermTransport } from '../src/aiterm-transport.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'
import { ConversationStore } from '../src/conversation-store.mjs'
import { requestMemberStop } from '../web/member-stop.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
test('連鎖中断口未接続なら4CLIとも作用せず、close/キー/消失確認へ戻らない', async () => {
  for (const harness of ['claude', 'codex', 'grok', 'cursor']) {
    const calls = [], bot = { id: 'bot-a', session: 'bot-a', harness }
    const transport = new AitermTransport({ client: { async call(name) { calls.push(name); throw Error('must not call') } } })
    await assert.rejects(transport.interrupt(bot), { code: 'BOT_STOP_UNCONFIRMED' })
    assert.deepEqual(calls, [])
    assert.equal(transport.uncertainChanges.size, 0)
  }
})

test('MCPのtoolエラー結果と、transportの応答欠測rejectは別の印になる', async () => {
  const client = new AitermClient()
  client.connect = async () => {}
  client.client = { callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'aiterm: close拒否' }] }) }
  await assert.rejects(client.call('pty_close', { session_id: 'synthetic' }), error => error.aitermResponseReturned === true)
  client.client.callTool = async () => { throw new Error('RPC response lost') }
  await assert.rejects(client.call('pty_close', { session_id: 'synthetic' }), error => error.aitermResponseReturned !== true)
})

test('停止APIは認証後に対象だけを止め、完了前に200を返さず、失敗を502にする', async t => {
  const bot = { id: 'bot-a' }, calls = [], gate = deferred(), entered = deferred()
  let fail = false
  const server = createBellTeamServer({ bots: new Map([[bot.id, bot]]), authorize: request => request.headers.authorization === 'Bearer synthetic',
    transport: { async interrupt(value) { calls.push(value.id); if (fail) throw new Error('unknown'); entered.resolve(); await gate.promise; return { botId: value.id, status: 'interrupted', sessionPreserved: true } } } })
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
  assert.deepEqual(await response.json(), { botId: 'bot-a', status: 'interrupted', sessionPreserved: true })
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
  for (const result of [{ botId: 'bot-a', status: 'stopped', online: false }, { botId: 'bot-a', status: 'interrupted', sessionPreserved: false }, { botId: 'other', status: 'interrupted', sessionPreserved: true }, { botId: 'bot-a', status: 'stopping', online: false }, { botId: 'bot-a', status: 'stopped', online: true }, null]) {
    const calls = []
    await assert.rejects(requestMemberStop('bot-a', async (...args) => { calls.push(args); return result }), /確認できません/u)
    assert.deepEqual(calls, [['/api/bots/bot-a/stop', { method: 'POST' }]])
  }
  let calls = 0
  await assert.rejects(requestMemberStop('bot-a', async () => { calls++; throw new Error('connection lost') }))
  assert.equal(calls, 1)
  const result = { botId: 'bot-a', status: 'interrupted', sessionPreserved: true, online: true }
  assert.equal(await requestMemberStop('bot-a', async () => result), result)
  const sent = { botId: 'bot-a', status: 'stop_sent' }
  assert.equal(await requestMemberStop('bot-a', async () => sent), sent)
})


test('HTTPは旧close結果や会話維持欠測を200へ流用しない', async t => {
  let result
  const server = createBellTeamServer({ bots: new Map([['bot-a', { id: 'bot-a' }]]), authorize: () => true,
    transport: { async interrupt() { return result } } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  for (result of [{ botId: 'bot-a', status: 'stopped', online: false },
    { botId: 'other', status: 'interrupted', sessionPreserved: true },
    { botId: 'bot-a', status: 'interrupted', sessionPreserved: false }]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bots/bot-a/stop`, { method: 'POST' })
    assert.equal(response.status, 502)
    assert.equal((await response.json()).error, 'BOT_STOP_UNCONFIRMED')
  }
})
