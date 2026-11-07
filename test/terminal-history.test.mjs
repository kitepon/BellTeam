import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'

test('screen reads only its target and logs a failed tick as offline', async t => {
  const rows = Array.from({ length: 10030 }, (_, i) => `ROW_${i}`)
  const calls = []
  let result = { content: [{ type: 'text', text: rows.join('\n') }] }
  const transport = new AitermTransport({ client: { async call(name, args) {
    calls.push({ name, args })
    assert.equal(name, 'pty_read')
    if (result instanceof Error) throw result
    return result
  } } })
  const bot = { id: 'bot-a', session: 'fixture' }
  assert.equal((await transport.screen(bot)).screen, rows.slice(-25).join('\n'))
  assert.equal((await transport.screen(bot, { history: true })).screen, rows.slice(-10000).join('\n'))
  assert.deepEqual(calls.map(c => c.args.lines), [40, 10000])
  assert.ok(calls.every(c => c.name === 'pty_read' && c.args.screen && c.args.raw && !c.args.full && c.args.timeout === 0))
  assert.ok(calls.every(c => c.args.session_id === 'fixture'))
  const failure = result = new Error('fixture connection failed')
  const log = t.mock.method(console, 'error', () => {})
  assert.deepEqual(await transport.screen(bot), { online: false, screen: '' })
  assert.equal(calls.length, 3)
  assert.deepEqual(log.mock.calls.map(call => call.arguments), [['Screen read failed', failure]])
})

test('認証付きscreen APIはhistory=1だけを履歴指定として渡す', async t => {
  const calls = []
  const server = createBellTeamServer({
    bots: new Map([['bot-a', { id: 'bot-a' }]]), messenger: {}, store: {},
    authorize: r => r.headers.authorization === 'fixture',
    transport: { async screen(bot, options) { calls.push(options); return { online: true, screen: bot.id } } },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/api/bots/bot-a/screen`
  assert.equal((await fetch(url + '?history=1')).status, 401)
  for (const query of ['', '?history=1', '?history=0']) {
    const response = await fetch(url + query, { headers: { authorization: 'fixture' } })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { online: true, screen: 'bot-a' })
  }
  assert.deepEqual(calls, [{ history: false }, { history: true }, { history: false }])
})
