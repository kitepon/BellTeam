import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const entry = fileURLToPath(new URL('../src/run-seat-mcp.mjs', import.meta.url))
const environment = (seat = 'bot-a', launch = 'a'.repeat(32)) => ({
  ...process.env, AITERM_SESSION_ID: seat, AITERM_AGENT_LAUNCH_ID: launch,
})
const initialize = { jsonrpc: '2.0', id: 0, method: 'initialize', params: {
  protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '0' },
} }
const tool = { name: 'echo', inputSchema: { type: 'object' } }

async function fixture(t) {
  const seen = []
  const events = new EventTarget()
  const pending = new Map()
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') { response.writeHead(405).end(); return }
    let raw = ''
    for await (const chunk of request) raw += chunk
    const message = JSON.parse(raw)
    const seat = request.headers['x-bellteam-seat']
    seen.push({ seat, launch: request.headers['x-bellteam-launch-id'], headers: request.headers, message })
    events.dispatchEvent(new Event(message.method))
    const reply = result => response.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    if (message.method === 'initialize') return reply({ protocolVersion: '2025-11-25',
      capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '0' }, instructions: 'keep instructions' })
    if (message.method === 'notifications/cancelled') {
      pending.get(seat)?.end()
      pending.delete(seat)
    }
    if (message.id === undefined) { response.writeHead(202).end(); return }
    if (message.method === 'tools/list') return reply({ tools: [tool] })
    const name = message.params?.name
    if (name === 'error') { response.writeHead(503).end('fixture unavailable'); return }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const event = value => response.write(`data: ${JSON.stringify({ jsonrpc: '2.0', ...value })}\n\n`)
    event({ method: 'notifications/progress', params: { progressToken: message.params._meta?.progressToken ?? 'unused', progress: 1 } })
    if (name === 'wait') { pending.set(seat, response); return }
    event({ id: message.id, result: { content: [{ type: 'text', text: seat }] } })
    response.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { for (const r of pending.values()) r.destroy(); server.closeAllConnections(); server.close() })
  return { seen, events, pending, url: `http://127.0.0.1:${server.address().port}/mcp` }
}

async function connect(t, url, seat, launch) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, url],
    env: environment(seat, launch), stderr: 'pipe' })
  let stderr = ''
  transport.stderr.on('data', chunk => { stderr += chunk })
  const client = new Client({ name: 'stdio-test', version: '0' }, { capabilities: {} })
  t.after(async () => { await client.close(); assert.equal(stderr, '') })
  await client.connect(transport)
  return client
}

function child(t, url, env) {
  const process = spawn(globalThis.process.execPath, [entry, url], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const exit = once(process, 'exit')
  let stdout = '', stderr = ''
  process.stdout.on('data', b => { stdout += b })
  process.stderr.on('data', b => { stderr += b })
  t.after(() => { if (process.exitCode === null && process.signalCode === null) process.kill() })
  return { process, exit, output: () => ({ stdout, stderr }), send: value => process.stdin.write(`${JSON.stringify(value)}\n`) }
}

test('stdio中継は二席のlaunchを分離し初期化・通知・SSE応答・取消しを保持する', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  const [a, b] = await Promise.all([connect(t, f.url, 'bot-a', 'a'.repeat(32)), connect(t, f.url, 'bot-b', 'b'.repeat(32))])
  assert.equal(a.getInstructions(), 'keep instructions')
  assert.deepEqual((await a.listTools()).tools, [tool])
  const progress = []
  assert.equal((await a.callTool({ name: 'echo', arguments: {} }, undefined, { onprogress: value => progress.push(value.progress) })).content[0].text, 'bot-a')
  assert.deepEqual(progress, [1])
  const started = once(f.events, 'tools/call')
  const controller = new AbortController()
  const waiting = a.callTool({ name: 'wait', arguments: {} }, undefined, { signal: controller.signal })
  const rejected = assert.rejects(waiting, /cancel fixture/)
  await started
  const cancelled = once(f.events, 'notifications/cancelled')
  controller.abort(new Error('cancel fixture'))
  await Promise.all([rejected, cancelled])
  assert.equal((await b.callTool({ name: 'echo', arguments: {} })).content[0].text, 'bot-b')
  for (const item of f.seen) {
    assert.equal(item.launch, (item.seat === 'bot-a' ? 'a' : 'b').repeat(32))
    if (item.message.method !== 'initialize') assert.equal(item.headers['mcp-protocol-version'], '2025-11-25')
  }
  assert.equal(f.seen.filter(x => x.message.method === 'initialize').length, 2)
  assert.equal(f.seen.filter(x => x.message.method === 'notifications/initialized').length, 2)
})

test('stdin EOFは要求途中の接続も閉じ自然終了し、上流エラーを再試行しない', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  const a = child(t, f.url, environment())
  a.send(initialize)
  await once(a.process.stdout, 'data')
  const started = once(f.events, 'tools/call')
  a.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait' } })
  await started
  const disconnected = once(f.pending.get('bot-a'), 'close')
  a.process.stdin.end()
  assert.deepEqual(await a.exit, [0, null])
  await disconnected
  assert.equal(a.output().stderr, '')
  const b = child(t, f.url, environment())
  b.send(initialize)
  await once(b.process.stdout, 'data')
  b.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'error' } })
  assert.deepEqual(await b.exit, [1, null])
  assert.match(b.output().stderr, /fixture unavailable/)
  assert.equal(f.seen.filter(x => x.message.params?.name === 'error').length, 1)
})

test('preflightの空環境や未展開launchは通信前に失敗し別の席へ代入しない', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  for (const env of [environment('', ''), environment('', 'a'.repeat(32)), environment('bot-a', ''), environment('bot-a', '${AITERM_AGENT_LAUNCH_ID}')]) {
    const p = child(t, f.url, env)
    assert.deepEqual(await p.exit, [1, null])
    assert.equal(p.output().stdout, '')
    assert.match(p.output().stderr, /BELLTEAM_SEAT_UNRESOLVED/)
  }
  assert.deepEqual(f.seen, [])
})
