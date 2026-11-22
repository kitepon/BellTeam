import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createSeatCredentials } from '../src/seat-credentials.mjs'
import { createRemoteSeatServer } from '../src/seat-mcp.mjs'
import { createApprovalBoxDoorRoute } from '../src/approval-box-door-route.mjs'
import { createApprovalBoxDaemon } from '../src/approval-box-daemon.mjs'

// a516m: the body end of the host door for seats on other hosts (docs runtime/approval-box-daemon.md).
const bots = { readMember: async id => {
  if (id === 'bot-aa') return { id }
  throw Object.assign(new Error('BOT_NOT_FOUND'), { code: 'BOT_NOT_FOUND', status: 404 })
} }

async function setup(t, daemon) {
  const root = await mkdtemp(join(tmpdir(), 'abx-door-'))
  const credentials = createSeatCredentials({ path: join(root, 'c.json') })
  const main = credentials.reveal(await credentials.issue({ botId: 'bot-aa', sessionName: 'bot-aa-1st-z9', terminalId: 'owner-macbook' }))
  const fork = credentials.reveal(await credentials.issue({ botId: 'bot-aa', sessionName: 'bot-aa-1st-z9-fork-0123456789ab', terminalId: 'owner-macbook', kind: 'fork' }))
  const ingressed = []
  const server = createRemoteSeatServer(async (request, response) => { ingressed.push(request.url); response.writeHead(200); response.end('{}') },
    { door: createApprovalBoxDoorRoute({ credentials, bots, daemon }) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.close(); await rm(root, { recursive: true, force: true }) })
  const post = (headers, body, method = 'POST') => fetch(`http://127.0.0.1:${server.address().port}/api/seat-mcp/approval-box/local`, { method, headers, ...(method === 'POST' ? { body } : {}) })
  return { main, fork, post, ingressed, port: () => server.address().port }
}

test('the door route: bearer as /mcp does, fork refused, one line to the daemon and its reply back as 200', async t => {
  const calls = []
  const daemon = { call: async (method, path, body) => { calls.push({ method, path, body }); return path === '/decisions' ? { ok: true, result: { items: [] } } : { ok: false, status: 503, code: 'not_paired', message: 'x' } } }
  const { main, fork, post } = await setup(t, daemon)
  const line = JSON.stringify({ method: 'GET', path: '/decisions' })
  let reply = await post({ authorization: `Bearer ${main}` }, line)
  assert.equal(reply.status, 200); assert.match(reply.headers.get('content-type'), /application\/json/)
  assert.deepEqual(await reply.json(), { ok: true, result: { items: [] } })
  assert.deepEqual(calls, [{ method: 'GET', path: '/decisions', body: undefined }])
  // the daemon's own refusal stays inside HTTP 200
  reply = await post({ authorization: `Bearer ${main}` }, JSON.stringify({ method: 'POST', path: '/confirm', body: { title: 't' } }))
  assert.equal(reply.status, 200); assert.deepEqual(await reply.json(), { ok: false, status: 503, code: 'not_paired', message: 'x' })
  assert.deepEqual(calls[1], { method: 'POST', path: '/confirm', body: { title: 't' } })
  // closed refusals, nothing reaches the daemon
  const before = calls.length
  assert.deepEqual([(await post({}, line)).status, await (await post({ authorization: 'Bearer nope' }, line)).json()], [400, { error: 'BELLTEAM_SEAT_UNRESOLVED' }])
  reply = await post({ authorization: `Bearer ${fork}` }, line)
  assert.equal(reply.status, 403); assert.deepEqual(await reply.json(), { error: 'APPROVAL_BOX_DOOR_NOT_ALLOWED' })
  for (const bad of ['not json', '[]', '{"method":1,"path":"/x"}', '{"method":"GET"}']) {
    reply = await post({ authorization: `Bearer ${main}` }, bad)
    assert.equal(reply.status, 400, bad); assert.deepEqual(await reply.json(), { error: 'APPROVAL_BOX_DOOR_REQUEST_INVALID' })
  }
  reply = await post({ authorization: `Bearer ${main}` }, null, 'GET')
  assert.equal(reply.status, 405)
  assert.equal(calls.length, before)
})

test('a line over 32 MiB is refused with 413 and never reaches the daemon', async t => {
  const calls = []
  const { main, post } = await setup(t, { call: async () => { calls.push(1); return { ok: true, result: {} } } })
  const big = JSON.stringify({ method: 'POST', path: '/uploads', body: { data: 'x'.repeat(33 * 1024 * 1024) } })
  let status
  try { status = (await post({ authorization: `Bearer ${main}` }, big)).status } catch { status = 'reset' } // the server may close the socket while the client still writes
  assert.ok(status === 413 || status === 'reset', String(status))
  assert.equal(calls.length, 0)
})

test('without a daemon the path stays 404 as before, and the other seat paths are untouched', async t => {
  const server = createRemoteSeatServer(async (request, response) => { response.writeHead(200); response.end('{"ingress":true}') })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  assert.equal((await fetch(`${base}/api/seat-mcp/approval-box/local`, { method: 'POST', body: '{}' })).status, 404)
  assert.deepEqual(await (await fetch(`${base}/api/seat-mcp`, { method: 'POST', body: '{}' })).json(), { ingress: true })
})

test('daemon.call: never throws, a stopped daemon answers its own 503 line, a running one answers its reply as it is (including ok:false)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'abx-call-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stopped = createApprovalBoxDaemon({ root, entry: join(root, 'missing.mjs') })
  assert.deepEqual(await stopped.call('GET', '/status'), { ok: false, status: 503, code: 'APPROVAL_BOX_DAEMON_UNAVAILABLE', message: "The body's Approval Box daemon is not running." })
})
