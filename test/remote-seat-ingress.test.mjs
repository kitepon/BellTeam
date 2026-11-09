import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSeatCredentials } from '../src/seat-credentials.mjs'
import { createRemoteSeatIngress } from '../src/seat-mcp.mjs'
import { createTerminalsApi } from '../src/http-terminals-api.mjs'

const bots = { readMember: async id => {
  if (id === 'bot-aa') return { id }
  throw Object.assign(new Error('BOT_NOT_FOUND'), { code: 'BOT_NOT_FOUND', status: 404 })
} }
const response = () => ({ status: null, body: null, writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body) } })

test('seat credential: hashed at rest, opaque ref, replace and revoke', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seat-cred-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'seat-credentials.json')
  const credentials = createSeatCredentials({ path })
  const ref = await credentials.issue({ botId: 'bot-aa', sessionName: 'bot-aa-2nd-k1', terminalId: 'owner-macbook' })
  const token = credentials.reveal(ref)
  assert.equal(JSON.stringify({ ref }), '{"ref":"[seat credential]"}')
  assert.equal((await readFile(path, 'utf8')).includes(token), false)
  // A fresh store (body restart) still verifies the running seat's token.
  const restarted = createSeatCredentials({ path })
  assert.deepEqual(await restarted.verify(`Bearer ${token}`), { sessionName: 'bot-aa-2nd-k1', botId: 'bot-aa', terminalId: 'owner-macbook' })
  assert.throws(() => restarted.reveal(ref), /SEAT_CREDENTIAL_INVALID/)
  const second = credentials.reveal(await credentials.issue({ botId: 'bot-aa', sessionName: 'bot-aa-2nd-k1', terminalId: 'owner-macbook' }))
  assert.equal(await credentials.verify(`Bearer ${token}`), null)
  assert.equal((await credentials.verify(`Bearer ${second}`)).sessionName, 'bot-aa-2nd-k1')
  await credentials.revoke({ sessionName: 'bot-aa-2nd-k1' })
  assert.equal(await credentials.verify(`Bearer ${second}`), null)
  await assert.rejects(credentials.issue({ botId: 'bot-aa', sessionName: '../x', terminalId: 'owner-macbook' }), /SEAT_CREDENTIAL_INVALID/)
})

test('remote ingress: seat comes from the credential, never the caller header', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seat-ingress-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const credentials = createSeatCredentials({ path: join(root, 'c.json') })
  const token = credentials.reveal(await credentials.issue({ botId: 'bot-aa', sessionName: 'bot-aa-1st-z9', terminalId: 'owner-macbook' }))
  const seen = []
  const ingress = createRemoteSeatIngress({ credentials, bots, seatMcp: () => async (request, _response, url) => seen.push({ headers: { ...request.headers }, path: url.pathname }) })
  const call = async (headers, path = '/api/seat-mcp') => {
    const out = response()
    await ingress({ headers }, out, new URL(`http://h${path}`))
    return out
  }
  await call({ authorization: `Bearer ${token}`, 'x-bellteam-seat': 'bot-other', 'x-bellteam-launch-id': 'a'.repeat(32) })
  await call({ authorization: `Bearer ${token}` }, '/api/seat-mcp/call-bridge')
  assert.deepEqual(seen.map(item => item.path), ['/mcp', '/mcp/call-bridge'])
  assert.equal(seen[0].headers['x-bellteam-seat'], 'bot-aa-1st-z9')
  assert.equal(seen[0].headers['x-bellteam-launch-id'], 'a'.repeat(32))
  assert.equal(seen[0].headers.authorization, undefined)
  assert.equal((await call({ 'x-bellteam-seat': 'bot-aa' })).body.error, 'BELLTEAM_SEAT_UNRESOLVED')
  assert.equal((await call({ authorization: 'Bearer nope' })).status, 400)
  // A deleted member no longer resolves.
  const gone = credentials.reveal(await credentials.issue({ botId: 'bot-bb', sessionName: 'bot-bb', terminalId: 'owner-macbook' }))
  assert.equal((await call({ authorization: `Bearer ${gone}` })).body.error, 'BELLTEAM_SEAT_UNRESOLVED')
  assert.equal(seen.length, 2)
})

test('terminals HTTP: owner only, typed 503 without a core', async () => {
  const url = new URL('http://h/api/terminals')
  const internal = response()
  await createTerminalsApi({ terminals: () => ({}), internal: true })({ method: 'GET' }, internal, url)
  assert.equal(internal.status, 403)
  await assert.rejects(createTerminalsApi({ terminals: () => null, internal: false })({ method: 'GET' }, response(), url), { code: 'TERMINALS_UNAVAILABLE', status: 503 })
  assert.equal(await createTerminalsApi({ terminals: () => null, internal: false })({ method: 'GET' }, response(), new URL('http://h/api/other')), false)
})

test('credential refresh: timer only while a binding is unavailable, stops on close', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let listener, calls = 0
  const { createCredentialRefresh } = await import('../src/secret-credential-refresh.mjs')
  const helper = createCredentialRefresh({ refresh: async () => { calls += 1 }, watch: next => { listener = next; return () => { listener = null } }, intervalMs: 1000 })
  t.mock.timers.tick(5000)
  assert.equal(calls, 0)
  listener({ handle: 'h1', revision: 1, available: false })
  t.mock.timers.tick(1000); await Promise.resolve(); await Promise.resolve()
  assert.equal(calls, 1)
  listener({ handle: 'h1', revision: 1, available: true })
  t.mock.timers.tick(5000)
  assert.equal(calls, 1)
  listener({ handle: 'h2', available: false })
  helper.stop()
  t.mock.timers.tick(5000)
  assert.equal(calls, 1)
  assert.equal(listener, null)
})
