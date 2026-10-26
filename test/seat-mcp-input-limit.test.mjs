import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { createBellTeamServer } from '../src/http-server.mjs'
import { createSeatMcp, SEAT_HEADER } from '../src/seat-mcp.mjs'

async function fixture(t) {
  const bots = new Map([['bot-fixture', { id: 'bot-fixture' }]])
  let invoked = 0
  const tools = { registry: { async refresh() { invoked += 1 }, get: id => bots.get(id) } }
  const server = createBellTeamServer({ bots, authorize: async () => true, messenger: {},
    transport: {}, store: {}, internal: true, seatMcp: createSeatMcp({ bots, tools }) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const call = args => fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', [SEAT_HEADER]: 'bot-fixture' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_self', arguments: args } }),
  })
  return { call, invoked: () => invoked }
}

test('MCP rejects excessive array elements below the byte limit before invoking a tool', async t => {
  const f = await fixture(t)
  const response = await f.call({ items: Array(20_000).fill(null) })
  assert.equal(response.status, 413)
  assert.equal(f.invoked(), 0)
  const next = await f.call({})
  assert.equal(next.status, 200)
  assert.equal(JSON.parse((await next.json()).result.content[0].text).bot.id, 'bot-fixture')
  assert.equal(f.invoked(), 1)
})

test('MCP rejects a large scalar body before invoking a tool and remains usable', async t => {
  const f = await fixture(t)
  const response = await f.call({ text: 'x'.repeat(4 * 1024 * 1024) })
  assert.equal(response.status, 413)
  assert.equal(f.invoked(), 0)
  const next = await f.call({})
  assert.equal(next.status, 200)
  assert.equal(JSON.parse((await next.json()).result.content[0].text).bot.id, 'bot-fixture')
  assert.equal(f.invoked(), 1)
})

test('MCP counts nested record members before SDK validation', async t => {
  const f = await fixture(t)
  const record = Object.fromEntries(Array.from({ length: 12_000 }, (_, i) => [`k${i}`, false]))
  const response = await f.call({ nested: { record } })
  assert.equal(response.status, 413)
  assert.equal(f.invoked(), 0)
})
