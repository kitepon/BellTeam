import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { createBellTeamServer } from '../src/http-server.mjs'
import { SEAT_HEADER, createSeatMcp, internalApi } from '../src/seat-mcp.mjs'

const registry = () => Object.assign(new Map([['bot-a', { id: 'bot-a', name: 'A' }], ['bot-b', { id: 'bot-b', name: 'B' }]]), { async refresh() {} })

async function listen(t, server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  return `http://127.0.0.1:${server.address().port}`
}

async function internalServer(t, seatMcp, internal = true) {
  return listen(t, createBellTeamServer({ bots: registry(), authorize: async () => true, messenger: {}, transport: {}, store: {}, internal, seatMcp }))
}

async function connect(t, url, seat) {
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: seat ? { [SEAT_HEADER]: seat } : {} } }))
  t.after(() => client.close())
  return client
}

test('席の名札ごとに、1つの入口が別のBotとして道具を実行する', async t => {
  const bots = registry()
  const base = await internalServer(t, createSeatMcp({ bots, tools: { registry: bots } }))
  const [a, b] = await Promise.all([connect(t, `${base}/mcp`, 'bot-a'), connect(t, `${base}/mcp`, 'bot-b')])
  assert.ok((await a.listTools()).tools.some(tool => tool.name === 'get_self'))
  const [selfA, selfB] = await Promise.all([a.callTool({ name: 'get_self', arguments: {} }), b.callTool({ name: 'get_self', arguments: {} })])
  assert.equal(JSON.parse(selfA.content[0].text).bot.id, 'bot-a')
  assert.equal(JSON.parse(selfB.content[0].text).bot.id, 'bot-b')
  assert.match(a.getInstructions(), /sendmessage/u)
})

test('名札が無い・展開されていない・台帳に無い要求は、どちらの入口でも席を決めずに拒む', async t => {
  const bots = registry()
  let relayed = 0
  const upstream = await listen(t, createServer((request, response) => { relayed += 1; response.end('{}') }))
  const headersFile = join(await mkdtemp(join(tmpdir(), 'bellteam-seat-mcp-')), 'headers')
  await writeFile(headersFile, 'Authorization: Bearer secret-token\n')
  const base = await internalServer(t, createSeatMcp({ bots, tools: { registry: bots }, callBridge: () => ({ url: `${upstream}/mcp`, headersFile }) }))
  for (const path of ['/mcp', '/mcp/call-bridge']) for (const seat of [undefined, '${AITERM_SESSION_ID}', '${env:AITERM_SESSION_ID}', 't1']) {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(seat ? { [SEAT_HEADER]: seat } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    // 403 だと Claude Code が全席共有の needs-auth の控えへ書き、本物の席の接続まで飛ばすので、400 で拒む。
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'BELLTEAM_SEAT_UNRESOLVED' })
  }
  assert.equal(relayed, 0)
  assert.equal((await fetch(`${base}/mcp`, { headers: { [SEAT_HEADER]: 'bot-a' } })).status, 405)
})

test('公開側の入口ではMCPを開かない', async t => {
  const bots = registry()
  const base = await internalServer(t, createSeatMcp({ bots, tools: { registry: bots } }), false)
  const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', [SEAT_HEADER]: 'bot-a' }, body: '{}' })
  assert.equal(response.status, 405)
})

test('通話ブリッジへの中継は合言葉と席の名札を付け直し、応答をそのまま返す', async t => {
  const seen = []
  const upstream = await listen(t, createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    seen.push({ method: request.method, headers: request.headers, body })
    if (request.method === 'DELETE') { response.writeHead(404, { 'content-type': 'application/json' }); return response.end('{"error":"session not found"}') }
    response.writeHead(request.method === 'GET' ? 200 : 201, { 'content-type': request.method === 'GET' ? 'text/event-stream' : 'application/json', 'mcp-session-id': 's1' })
    response.end(request.method === 'GET' ? 'data: hello\n\n' : '{"ok":true}')
  }))
  const headersFile = join(await mkdtemp(join(tmpdir(), 'bellteam-seat-mcp-')), 'headers')
  await writeFile(headersFile, 'Authorization: Bearer secret-token\n')
  const bots = registry()
  let target = { url: `${upstream}/mcp`, headersFile }
  const base = await internalServer(t, createSeatMcp({ bots, tools: { registry: bots }, callBridge: () => target }))

  const posted = await fetch(`${base}/mcp/call-bridge`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25', [SEAT_HEADER]: 'bot-a',
      // 席のCLIが付けてきた合言葉と名札は流さない。
      authorization: 'Bearer from-seat', 'x-call-bridge-caller-id': 'bot-b', 'x-other': 'no',
    },
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  })
  assert.equal(posted.status, 201)
  assert.equal(posted.headers.get('mcp-session-id'), 's1')
  assert.deepEqual(await posted.json(), { ok: true })
  assert.equal(seen[0].body, '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
  assert.equal(seen[0].headers.authorization, 'Bearer secret-token')
  assert.equal(seen[0].headers['x-call-bridge-caller-id'], 'bot-a')
  assert.equal(seen[0].headers['mcp-protocol-version'], '2025-11-25')
  assert.equal(seen[0].headers['x-other'], undefined)
  assert.equal(seen[0].headers['x-bellteam-seat'], undefined)

  const stream = await fetch(`${base}/mcp/call-bridge`, { headers: { accept: 'text/event-stream', 'mcp-session-id': 's1', [SEAT_HEADER]: 'bot-b' } })
  assert.equal(stream.headers.get('content-type'), 'text/event-stream')
  assert.equal(await stream.text(), 'data: hello\n\n')
  assert.equal(seen[1].headers['x-call-bridge-caller-id'], 'bot-b')
  assert.equal(seen[1].headers['mcp-session-id'], 's1')

  // 通話ブリッジが再起動した後の404は、CLIが初期化し直せるようそのまま返す。
  const gone = await fetch(`${base}/mcp/call-bridge`, { method: 'DELETE', headers: { 'mcp-session-id': 'old', [SEAT_HEADER]: 'bot-a' } })
  assert.equal(gone.status, 404)
  assert.deepEqual(await gone.json(), { error: 'session not found' })

  target = { url: 'http://127.0.0.1:1/mcp', headersFile }
  const unreachable = await fetch(`${base}/mcp/call-bridge`, { method: 'POST', headers: { 'content-type': 'application/json', [SEAT_HEADER]: 'bot-a' }, body: '{}' })
  assert.equal(unreachable.status, 502)
  assert.deepEqual(await unreachable.json(), { error: 'CALL_BRIDGE_UNREACHABLE', message: 'ECONNREFUSED' })

  target = null
  assert.equal((await fetch(`${base}/mcp/call-bridge`, { method: 'POST', headers: { [SEAT_HEADER]: 'bot-a' }, body: '{}' })).status, 404)
})

test('上流が応答の途中で切れたら席側の流れも切り、上流の401と合言葉の欠落は502で返す', async t => {
  let mode = 'cut'
  const upstream = await listen(t, createServer((request, response) => {
    if (mode === '401') { response.writeHead(401, { 'www-authenticate': 'Bearer' }); return response.end('{}') }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: first\n\n')
    setTimeout(() => response.socket.destroy(), 20)
  }))
  const directory = await mkdtemp(join(tmpdir(), 'bellteam-seat-mcp-'))
  let headersFile = join(directory, 'headers')
  await writeFile(headersFile, 'Authorization: Bearer secret-token\n')
  const bots = registry()
  const base = await internalServer(t, createSeatMcp({ bots, tools: { registry: bots }, callBridge: () => ({ url: `${upstream}/mcp`, headersFile }) }))
  const call = () => fetch(`${base}/mcp/call-bridge`, { method: 'POST', headers: { 'content-type': 'application/json', [SEAT_HEADER]: 'bot-a' }, body: '{}' })

  const cut = await call()
  const reader = cut.body.getReader()
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n')
  await assert.rejects(reader.read())

  mode = '401'
  const denied = await call()
  assert.equal(denied.status, 502)
  assert.equal(denied.headers.get('www-authenticate'), null)
  assert.deepEqual(await denied.json(), { error: 'CALL_BRIDGE_AUTH_FAILED' })

  headersFile = join(directory, 'missing')
  const missing = await call()
  assert.equal(missing.status, 502)
  assert.deepEqual(await missing.json(), { error: 'CALL_BRIDGE_AUTH_UNAVAILABLE' })
})

test('中継の流れは届いた分からすぐ流し、本体を止める時に終える', async t => {
  const upstream = await listen(t, createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: first\n\n')
    // 上流は流れを開いたままにする。
  }))
  const headersFile = join(await mkdtemp(join(tmpdir(), 'bellteam-seat-mcp-')), 'headers')
  await writeFile(headersFile, 'Authorization: Bearer secret-token\n')
  const bots = registry()
  const server = createBellTeamServer({ bots, authorize: async () => true, messenger: {}, transport: {}, store: {}, internal: true,
    seatMcp: createSeatMcp({ bots, tools: { registry: bots }, callBridge: () => ({ url: `${upstream}/mcp`, headersFile }) }) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp/call-bridge`, { headers: { accept: 'text/event-stream', [SEAT_HEADER]: 'bot-a' } })
  const reader = response.body.getReader()
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n')
  const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  assert.equal((await reader.read()).done, true)
  await closed
})

test('道具が使う本体のAPIは、内部入口の同じ経路を呼ぶ', async () => {
  const calls = []
  const api = internalApi(4181, async (url, init) => {
    calls.push([url, init.method, init.body])
    return { ok: true, json: async () => ({ items: [{ botId: 'bot-a' }, { botId: 'bot-b' }] }) }
  })
  await api.deliverMessage({ from: 'bot-a' })
  assert.deepEqual(await api.listQueued('bot-b'), { items: [{ botId: 'bot-b' }] })
  await api.configure('bot-a', { model: 'm' })
  await api.remove('bot-a')
  assert.deepEqual(calls, [
    ['http://127.0.0.1:4181/api/deliveries/direct', 'POST', '{"from":"bot-a"}'],
    ['http://127.0.0.1:4181/api/queue', 'GET', undefined],
    ['http://127.0.0.1:4181/api/bots/bot-a', 'PATCH', '{"model":"m"}'],
    ['http://127.0.0.1:4181/api/bots/bot-a', 'DELETE', undefined],
  ])
})
