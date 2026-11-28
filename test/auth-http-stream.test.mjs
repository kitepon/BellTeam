import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { authHttpStream } from '../src/auth-http-stream.mjs'

const frame = (tag, data) => { const body = Buffer.from(data); const head = Buffer.alloc(5); head[0] = tag; head.writeUInt32BE(body.length, 1); return Buffer.concat([head, body]) }
async function module(t, answer) {
  const directory = await mkdtemp(join(tmpdir(), 'bellteam-http-stream-'))
  const socket = join(directory, 'caller.sock'), seen = []
  const server = createServer(connection => {
    let line = ''
    connection.on('error', () => {})
    connection.on('data', chunk => { line += chunk; if (line.includes('\n')) { seen.push(JSON.parse(line.split('\n')[0])); line = ''; answer(connection) } })
  })
  await new Promise(resolve => server.listen(socket, resolve))
  t.after(async () => { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }) })
  return { socket, seen }
}
const read = async stream => { const parts = []; for await (const part of stream) parts.push(part); return Buffer.concat(parts).toString() }

test('the request line carries the item, method, path, headers and a base64 body; frames split anywhere are put together', async t => {
  const { socket, seen } = await module(t, connection => {
    const all = Buffer.concat([Buffer.from(JSON.stringify({ outcome: 'granted' }) + '\n'), frame(4, ''), frame(5, JSON.stringify({ status: 201, headers: { 'mcp-session-id': 's1' } })), frame(1, 'data: he'), frame(1, 'llo\n\n'), frame(3, '0')])
    // one byte at a time: a frame (and the answer line) may arrive in any pieces
    let at = 0
    const timer = setInterval(() => { if (at >= all.length) { clearInterval(timer); return connection.end() } connection.write(all.subarray(at, ++at)) }, 0)
  })
  const upstream = await authHttpStream({ socket, name: 'item-x' })({ method: 'POST', path: '/mcp', headers: { accept: 'application/json' }, body: Buffer.from('{"a":1}') })
  assert.deepEqual([upstream.status, upstream.headers], [201, { 'mcp-session-id': 's1' }])
  assert.equal(await read(upstream.body), 'data: hello\n\n')
  assert.deepEqual(seen, [{ op: 'http-stream', name: 'item-x', method: 'POST', path: '/mcp', headers: { accept: 'application/json' }, body: Buffer.from('{"a":1}').toString('base64') }])
})

test('a refusal, a module error, a silent module and a missing socket reject with fixed codes and never carry the module\'s words', async t => {
  for (const [outcome, code] of [['denied', 'CALL_BRIDGE_AUTH_FAILED'], ['unknown-caller', 'CALL_BRIDGE_AUTH_FAILED'], ['not-registered', 'CALL_BRIDGE_AUTH_FAILED'], ['error', 'CALL_BRIDGE_UNREACHABLE']]) {
    const { socket } = await module(t, connection => connection.end(JSON.stringify({ outcome, error: 'PRIVATE WORDS' }) + '\n'))
    await assert.rejects(authHttpStream({ socket, name: 'x' })({ method: 'GET', path: '/mcp' }), error => error.code === code && !error.message.includes('PRIVATE'))
  }
  const silent = await module(t, () => {})
  await assert.rejects(authHttpStream({ socket: silent.socket, name: 'x', answerMs: 100 })({ method: 'GET', path: '/mcp' }), { code: 'CALL_BRIDGE_UNREACHABLE' })
  await assert.rejects(authHttpStream({ socket: join(tmpdir(), 'bellteam-no-such.sock'), name: 'x' })({ method: 'GET', path: '/mcp' }), { code: 'CALL_BRIDGE_UNREACHABLE' })
  const bad = await module(t, connection => connection.end(JSON.stringify({ outcome: 'granted' }) + '\n' + 'x'.repeat(5)))
  await assert.rejects(authHttpStream({ socket: bad.socket, name: 'x', answerMs: 200 })({ method: 'GET', path: '/mcp' }), { code: 'CALL_BRIDGE_UNREACHABLE' })
})

test('a stream cut after the status frame destroys the body; abort() closes the module connection', async t => {
  const cut = await module(t, connection => { connection.write(JSON.stringify({ outcome: 'granted' }) + '\n'); connection.write(frame(5, '{"status":200,"headers":{}}')); connection.write(frame(1, 'first')); setTimeout(() => connection.destroy(), 20) })
  const upstream = await authHttpStream({ socket: cut.socket, name: 'x' })({ method: 'GET', path: '/mcp' })
  await assert.rejects(read(upstream.body), { code: 'CALL_BRIDGE_UNREACHABLE' })
  let closed
  const gone = new Promise(resolve => { closed = resolve })
  const open = await module(t, connection => { connection.write(JSON.stringify({ outcome: 'granted' }) + '\n'); connection.write(frame(5, '{"status":200,"headers":{}}')); connection.on('close', closed) })
  const live = await authHttpStream({ socket: open.socket, name: 'x' })({ method: 'GET', path: '/mcp' })
  live.abort()
  await gone
})
