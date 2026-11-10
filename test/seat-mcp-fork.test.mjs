// Read-only fork seats in the seat MCP (remote-seat-ingress.md SK01-SK06).
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { createBellTeamServer } from '../src/http-server.mjs'
import { bellTeamTools } from '../src/mcp-tools.mjs'
import { createSeatCredentials } from '../src/seat-credentials.mjs'
import { SEAT_HEADER, createRemoteSeatIngress, createSeatMcp, internalApi, seatCandidates } from '../src/seat-mcp.mjs'

const FORK = 'bot-a-fork-0123456789ab'
const registry = () => Object.assign(new Map([['bot-a', { id: 'bot-a', name: 'A' }]]), { async refresh() {} })

async function serve(t, seatMcp) {
  const server = createBellTeamServer({ bots: registry(), authorize: async () => true, messenger: {}, transport: {}, store: {}, internal: true, seatMcp })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  return `http://127.0.0.1:${server.address().port}`
}

async function connect(t, url, seat) {
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { [SEAT_HEADER]: seat } } }))
  t.after(() => client.close())
  return client
}

test('fork seat: lists only read-only tools and refuses every other call before its handler', async t => {
  const bots = registry()
  const recalled = []
  const memory = { recallMemory: async input => { recalled.push(input); return { items: [] } } }
  const forkSeat = name => name === FORK ? { botId: 'bot-a', forkId: 'f1' } : null
  const base = await serve(t, createSeatMcp({ bots, forkSeat, tools: { registry: bots, memory, messenger: { sendmessage: () => assert.fail('fork sent a message') } } }))
  const fork = await connect(t, `${base}/mcp`, FORK)
  const listed = (await fork.listTools()).tools
  const readOnly = bellTeamTools.filter(tool => tool.annotations?.readOnlyHint === true).map(tool => tool.name)
  assert.deepEqual(listed.map(tool => tool.name), readOnly)
  assert.ok(readOnly.includes('recall_memory') && !readOnly.includes('sendmessage') && !readOnly.includes('remember'))
  const refused = await fork.callTool({ name: 'sendmessage', arguments: { target: 'bot-a', message: 'x' } }).catch(error => ({ isError: true, content: [{ text: error.message }] }))
  assert.equal(refused.isError, true)
  assert.match(refused.content[0].text, /FORK_READ_ONLY: sendmessage/u)
  await fork.callTool({ name: 'recall_memory', arguments: { query: 'q' } })
  assert.deepEqual(recalled, [{ botId: 'bot-a', query: 'q' }])
  // The main seat is unchanged.
  const main = await connect(t, `${base}/mcp`, 'bot-a')
  assert.ok((await main.listTools()).tools.some(tool => tool.name === 'sendmessage'))
})

test('fork seat: unknown fork names never resolve as main, registry failure is 503, call-bridge is refused', async t => {
  assert.deepEqual(seatCandidates(FORK), [])
  assert.deepEqual(seatCandidates('bot-a-1st-k1-fork-0123456789ab'), [])
  const bots = registry()
  let fail = false
  const forkSeat = name => { if (fail) throw new Error('down'); return name === FORK ? { botId: 'bot-a', forkId: 'f1' } : null }
  const base = await serve(t, createSeatMcp({ bots, forkSeat, tools: { registry: bots }, callBridge: () => assert.fail('fork reached call-bridge') }))
  const post = (path, seat) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', [SEAT_HEADER]: seat }, body: '{}' })
  assert.equal((await (await post('/mcp', 'bot-a-fork-ffffffffffff')).json()).error, 'BELLTEAM_SEAT_UNRESOLVED')
  const bridge = await post('/mcp/call-bridge', FORK)
  assert.deepEqual([bridge.status, (await bridge.json()).error], [404, 'FORK_READ_ONLY'])
  fail = true
  const down = await post('/mcp', 'bot-a')
  assert.deepEqual([down.status, (await down.json()).error], [503, 'EXECUTION_UNAVAILABLE'])
})

test('fork credential: kind round-trips, other kinds are invalid, ingress runs the seat MCP in fork mode', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seat-fork-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const credentials = createSeatCredentials({ path: join(root, 'c.json') })
  const token = credentials.reveal(await credentials.issue({ botId: 'bot-a', sessionName: FORK, terminalId: 'mac', kind: 'fork' }))
  assert.deepEqual(await credentials.verify(`Bearer ${token}`), { sessionName: FORK, botId: 'bot-a', terminalId: 'mac', kind: 'fork' })
  await assert.rejects(credentials.issue({ botId: 'bot-a', sessionName: 'bot-a', terminalId: 'mac', kind: 'owner' }), /SEAT_CREDENTIAL_INVALID/u)
  const seen = []
  const ingress = createRemoteSeatIngress({ credentials, bots: registry(), seatMcp: () => async (request, _response, url, fork) => seen.push([url.pathname, request.headers[SEAT_HEADER.toLowerCase()], fork]) })
  await ingress({ headers: { authorization: `Bearer ${token}` } }, {}, new URL('http://h/api/seat-mcp'))
  assert.deepEqual(seen, [['/mcp', FORK, { botId: 'bot-a' }]])
})

test('deliverForkInquiry posts to the fork delivery route with the seat source', async () => {
  const calls = []
  const executionSource = { sourceSession: 'bot-a', source: { launch: null, boundary: null } }
  const api = internalApi(4181, async (url, init) => { calls.push([url, init.headers[SEAT_HEADER], JSON.parse(init.body)]); return { ok: true, json: async () => ({ delivery: 'running' }) } }, { executionSource })
  assert.deepEqual(await api.deliverForkInquiry({ from: 'bot-a', target: 'bot-b', message: 'm' }), { delivery: 'running' })
  assert.deepEqual(calls, [['http://127.0.0.1:4181/api/deliveries/fork', 'bot-a', { from: 'bot-a', target: 'bot-b', message: 'm', executionSource }]])
})

test('internal HTTP (SK07): a running fork reads as its Bot, never writes, and fails closed', async t => {
  const runs = []
  let fail = false
  const transport = {
    forkSeat: name => { if (fail) throw new Error('down'); return name === FORK ? { botId: 'bot-a', forkId: 'f1' } : null },
    queueItems: () => [{ botId: 'bot-a' }],
  }
  const conversationAssembly = { run: (actor, operation, options) => { runs.push([actor, options?.executionSource?.sourceSession ?? null]); return operation() } }
  const messenger = { sendmessage: () => assert.fail('fork reached the direct write path') }
  const server = createBellTeamServer({ bots: registry(), authorize: async () => true, messenger, transport, store: {}, internal: true, conversationAssembly })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const call = (method, path, seat) => fetch(`${base}${path}`, { method, headers: { [SEAT_HEADER]: seat, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: '{"from":"bot-a","target":"bot-a","message":"x"}' } : {}) })
  const read = await call('GET', '/api/queue', FORK)
  assert.equal(read.status, 200)
  assert.deepEqual(runs.at(-1), [{ kind: 'bot', botId: 'bot-a' }, FORK])
  const write = await call('POST', '/api/deliveries/direct', FORK)
  assert.deepEqual([write.status, (await write.json()).error], [400, 'FORK_READ_ONLY'])
  // An unknown fork name is no Bot; a main seat keeps its own identity.
  await call('GET', '/api/queue', 'bot-a-fork-ffffffffffff')
  assert.equal(runs.at(-1)[0], null)
  await call('GET', '/api/queue', 'bot-a')
  assert.deepEqual(runs.at(-1), [{ kind: 'bot', botId: 'bot-a' }, 'bot-a'])
  fail = true
  assert.equal((await call('GET', '/api/queue', FORK)).status, 503)
})
