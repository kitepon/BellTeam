import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { createServer, connect } from 'node:net'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAuthCore } from '../src/auth-mediation/core.mjs'
import { createItemCache } from '../src/auth-mediation/items.mjs'
import { emptyPolicy } from '../src/auth-mediation/policy.mjs'
import { makeScrubber, pipeHttpStream } from '../src/auth-mediation/httpstream.mjs'

const AUTHC = new URL('../scripts/auth-mediation/auth', import.meta.url).pathname
const UNIT = '/home/kite/call-bridge'
const framesOf = buffer => { const out = []; let b = buffer; while (b.length >= 5 && b.length >= 5 + b.readUInt32BE(1)) { const n = b.readUInt32BE(1); out.push([b[0], b.subarray(5, 5 + n)]); b = b.subarray(5 + n) } return out }

test('stream scrubber: a secret split across chunks (raw or base64) is replaced, everything else passes byte for byte', () => {
  const sc = makeScrubber(['secret-token-123']); const parts = ['abc secret-', 'token-1', '23 def', ' tail']
  const out = Buffer.concat([...parts.map(p => sc.push(Buffer.from(p))), sc.end()]).toString()
  assert.equal(out, 'abc [redacted] def tail')
})

test('http stream through the core: same grant and credential, the response is piped as frames (status+headers first, body chunks scrubbed, end code last); no grant, no stream', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hs-')), sockPath = join(dir, 'x.sock'); let bytes = Buffer.alloc(0), done; const closed = new Promise(r => { done = r })
  const server = createServer({ allowHalfOpen: true }, s => { s.on('data', d => { bytes = Buffer.concat([bytes, d]) }); s.on('end', () => s.end()); s.on('close', done) }); await new Promise(r => server.listen(sockPath, r))
  const fields = { http_base: 'https://bridge.example.com', http_auth: 'bearer', http_secret: 'client-token-abcdef', http_methods: 'GET POST' }
  const store = { policy: { ...emptyPolicy(), vault: 'v', units: { [UNIT]: { grants: [{ command: 'http bridge' }] } } }, read: async () => structuredClone(store.policy) }
  const seen = [], enc = new TextEncoder()
  const fetchImpl = async (url, o) => { seen.push({ url: String(url), auth: o.headers.authorization }); return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode('data: hello client-tok')); c.enqueue(enc.encode('en-abcdef end\n\n')); c.close() } }), { status: 200, headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 's1', 'set-cookie': 'a=b' } }) }
  const core = createAuthCore({ store, items: createItemCache({ runOp: async () => JSON.stringify({ fields: Object.entries(fields).map(([label, value]) => ({ label, value })) }) }), audit: () => {}, roots: () => ({}), fetchImpl })
  const ask = (name, extra = {}) => core.http({ name, method: 'GET', path: '/mcp', via: 'host-socket', cwd: UNIT, unit: UNIT, stream: sockPath, ...extra })
  assert.deepEqual(await ask('bridge'), { outcome: 'granted' }); await closed; server.close()
  const frames = framesOf(bytes); assert.equal(frames[0][0], 5); assert.deepEqual(JSON.parse(frames[0][1]), { status: 200, headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 's1' } })
  assert.equal(Buffer.concat(frames.filter(f => f[0] === 1).map(f => f[1])).toString(), 'data: hello [redacted] end\n\n'); assert.equal(frames.at(-1)[0], 3); assert.equal(seen[0].auth, 'Bearer client-token-abcdef')
  assert.equal((await ask('other')).outcome, 'denied'); assert.equal(seen.length, 1)
})

test("auth serve: a loopback HTTP forwarder; the client sends no credential, the module's frames become the HTTP response, a refusal becomes 403", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'serve-')), sock = join(dir, 'container.sock'), seen = []
  const frame = (tag, data) => { const h = Buffer.alloc(5); h[0] = tag; h.writeUInt32BE(data.length, 1); return Buffer.concat([h, data]) }
  const module = createServer(c => { let buf = ''; c.on('data', d => { buf += d; if (!buf.includes('\n')) return; const req = JSON.parse(buf); seen.push(req)
    if (req.name === 'nope') return c.end(JSON.stringify({ outcome: 'denied', error: 'This command is not permitted.' }) + '\n')
    c.write(JSON.stringify({ outcome: 'granted' }) + '\n'); c.write(frame(5, Buffer.from(JSON.stringify({ status: 202, headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'S' } })))); c.write(frame(1, Buffer.from('data: one\n\n')))
    setTimeout(() => { c.write(frame(1, Buffer.from('data: two\n\n'))); c.write(frame(3, Buffer.from('0'))); c.end() }, 150) }) })
  await new Promise(r => module.listen(sock, r))
  const start = name => new Promise((resolve, reject) => { const child = spawn('python3', ['-I', AUTHC, 'serve', name, '--listen', '127.0.0.1:0'], { env: { ...process.env, AUTH_SOCK: sock } }); child.stdout.once('data', d => resolve({ child, port: Number(/:(\d+)\s*$/u.exec(String(d).trim())[1]) })); child.on('error', reject) })
  const get = (port, path, headers = {}) => new Promise((resolve, reject) => { const r = httpRequest({ host: '127.0.0.1', port, path, headers, agent: false }, res => { let body = ''; res.on('data', d => { body += d }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body })) }); r.on('error', reject); r.end() })
  const a = await start('bridge'), b = await start('nope')
  try {
    const r = await get(a.port, '/mcp?x=1', { authorization: 'Bearer should-not-pass', accept: 'text/event-stream' })
    assert.equal(r.status, 202); assert.equal(r.headers['mcp-session-id'], 'S'); assert.equal(r.body, 'data: one\n\ndata: two\n\n')
    assert.equal(seen[0].op, 'http-stream'); assert.equal(seen[0].path, '/mcp?x=1'); assert.equal(seen[0].headers.authorization, undefined); assert.equal(seen[0].headers.accept, 'text/event-stream')
    assert.equal((await get(b.port, '/mcp')).status, 403)
  } finally { a.child.kill(); b.child.kill(); module.close() }
})
