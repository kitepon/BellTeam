import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createHomeLogin } from '../src/usage/home-login.mjs'
import { createHomeFront } from '../src/home-login-front.mjs'

// The vendored library files are byte-identical to the accepted release v0.18.5 (selfhosted-form 1.0.3); a repin changes these two lines.
const PINS = {
  'src/usage/vendor/login-billing-home.mjs': 'ae37de43550cc8d502c22501913997fa665d640a7e36b4b0fc0de51fc3d71ee0',
  'src/vendor/login-billing-home-guard.mjs': 'a375769afe49af4149c289272185bdba5bd339a21aac9c50d5968136861591b3',
}
const GOOD = 'A'.repeat(22)
const ORIGIN = 'http://192.168.1.2:18893'

async function setup({ operatorStatus = { prove: 200, check: 200 } } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'home-login-'))
  const prints = []
  const operator = { calls: [], status: operatorStatus }
  const operatorFetch = async (url, init) => {
    const path = new URL(url).pathname.replace(/^.*\//u, '')
    const body = JSON.parse(init.body)
    operator.calls.push([path, body])
    if (path === 'prove/take' || url.endsWith('prove/take')) {
      if (body.code !== GOOD) return new Response('{}', { status: 404 })
      return new Response(JSON.stringify({ k: 'account-1', passId: 'pass-1', ticket: 'ticket-1', entitlements: [{ productId: 'p', kind: 'subscription', store: 'apple' }] }), { status: operator.status.prove })
    }
    return new Response('{}', { status: operator.status.check })
  }
  const clock = { t: Date.now() }
  const home = createHomeLogin({ path: join(dir, 'login-home.json'), operator: 'https://operator.test/auth/v1', fetch: operatorFetch, now: () => clock.t })
  const methods = { 'home.handle': p => home.handle(p), 'home.sweep': p => home.sweep(p), 'home.setupCode': () => home.setupCode(), 'home.publish': () => home.publish(), 'home.console': p => home.console(p) }
  const front = createHomeFront({ call: (name, params) => methods[name](params), markerPath: join(dir, 'login-enforced'), print: line => prints.push(line), now: () => clock.t, setTimer: () => ({ unref() {} }), clearTimer() {} })
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://x')
    if (await front.route(request, response, url)) return
    const who = await front.judge(request.headers)
    response.writeHead(who === 'unavailable' ? 503 : who === 'none' ? 401 : 200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ who }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const api = async (method, path, { body, token } = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
    return { status: response.status, body: await response.json() }
  }
  const login = async ({ setupCode, kind = 'android', ticketFor = 'a'.repeat(64) } = {}) => {
    const { body: { nonce } } = await api('POST', '/api/home/login/nonce', { body: {} })
    return api('POST', '/api/home/login/prove', { body: { code: GOOD, audience: ORIGIN, nonce, kind, ticketFor, ...(setupCode ? { setupCode } : {}) } })
  }
  return { dir, prints, operator, clock, home, front, server, api, login, async close() { server.closeAllConnections(); server.close(); front.stop(); await rm(dir, { recursive: true, force: true }) } }
}
const code = prints => /code: (\S+) /u.exec(prints.at(-1))[1]

test('the vendored library files are the pinned accepted release', async () => {
  for (const [path, hash] of Object.entries(PINS)) assert.equal(createHash('sha256').update(await readFile(new URL(`../${path}`, import.meta.url))).digest('hex'), hash)
})

test('unbound: Legacy, the setup code is printed by the body, the first proof binds and enforces', async () => {
  const t = await setup()
  try {
    await t.front.start()
    assert.equal(await t.front.judge({}), 'legacy')
    assert.equal(t.prints.length, 1)
    assert.match(t.prints[0], /setup code/u)
    assert.deepEqual((await t.api('GET', '/api/home/session')).body, { capability: 'login-billing-home/1', bound: false, enforced: false })
    assert.equal((await t.login()).body.error, 'SETUP_CODE_REQUIRED')
    assert.equal((await t.login({ setupCode: 'WRONGCODE' })).body.error, 'LOGIN_CODE_INVALID')
    const first = await t.login({ setupCode: code(t.prints) })
    assert.equal(first.status, 200)
    assert.equal(first.body.state, 'active')
    await access(join(t.dir, 'login-enforced'))
    assert.deepEqual((await t.api('GET', '/api/home/session')).body, { capability: 'login-billing-home/1', bound: true, enforced: true })
    // Enforced: the guard, no call to the child
    assert.deepEqual(await t.front.judge({ authorization: `Bearer ${first.body.token}` }), { sessionId: first.body.sessionId })
    assert.equal(await t.front.judge({ authorization: 'Bearer nope' }), 'none')
    assert.equal(await t.front.judge({}), 'none')
    assert.equal(t.front.stateOf(first.body.sessionId), 'active')
    // a second app (any app kind), the same account: no setup code now
    const second = await t.login({ kind: 'apple', ticketFor: 'b'.repeat(64) })
    assert.equal(second.status, 200)
    assert.notEqual(second.body.sessionId, first.body.sessionId)
    // the audience is the registered address only
    const { body: { nonce } } = await t.api('POST', '/api/home/login/nonce', { body: {} })
    assert.equal((await t.api('POST', '/api/home/login/prove', { body: { code: GOOD, audience: 'http://10.0.0.9:18893', nonce, kind: 'apple' } })).body.error, 'AUDIENCE_UNKNOWN')
  } finally { await t.close() }
})

test('a stop from the phone ends the session at the next ticket check; only a 401 answer ends it', async () => {
  const t = await setup()
  try {
    await t.front.start()
    const first = await t.login({ setupCode: code(t.prints) })
    const token = first.body.token
    // the operator cannot be reached: nothing ends, the state is kept
    t.operator.status.check = 503
    await t.api('GET', '/x', { token }) // marks use
    t.clock.t += 11 * 60_000
    await t.front.tick()
    assert.deepEqual(await t.front.judge({ authorization: `Bearer ${token}` }), { sessionId: first.body.sessionId })
    assert.equal(t.front.stateOf(first.body.sessionId), 'active')
    // the operator answers "that device stopped" (401): the session ends, the guard says none, the next request is 401
    t.operator.status.check = 401
    await t.api('GET', '/x', { token })
    t.clock.t += 11 * 60_000
    await t.front.tick()
    assert.equal(await t.front.judge({ authorization: `Bearer ${token}` }), 'none')
    assert.equal((await t.api('GET', '/x', { token })).status, 401)
  } finally { await t.close() }
})

test('a529m: the device list carries passId on account rows only, marks the caller, and ends one device at once', async () => {
  const t = await setup()
  try {
    await t.front.start()
    const first = await t.login({ setupCode: code(t.prints), kind: 'linux' })
    const second = await t.login({ kind: 'windows', ticketFor: 'b'.repeat(64) })
    const list = await t.api('GET', '/api/home/sessions', { token: first.body.token })
    assert.equal(list.status, 200)
    const rows = Object.fromEntries(list.body.sessions.map(row => [row.id, row]))
    assert.deepEqual(Object.keys(rows).sort(), [first.body.sessionId, second.body.sessionId].sort())
    assert.deepEqual([rows[first.body.sessionId].current, rows[second.body.sessionId].current], [true, false])
    assert.deepEqual([rows[first.body.sessionId].appKind, rows[second.body.sessionId].appKind], ['linux', 'windows'])
    assert.ok(list.body.sessions.every(row => row.kind === 'account' && row.passId === 'pass-1' && row.state === 'active'))
    assert.ok(list.body.sessions.every(row => !JSON.stringify(row).includes(first.body.token) && !('ticket' in row) && !('k' in row)))
    // end the other device: at once, its token is none, the caller stays
    assert.deepEqual((await t.api('DELETE', `/api/home/sessions/${second.body.sessionId}`, { token: first.body.token })).body, { ok: true })
    assert.equal(await t.front.judge({ authorization: `Bearer ${second.body.token}` }), 'none')
    assert.deepEqual(await t.front.judge({ authorization: `Bearer ${first.body.token}` }), { sessionId: first.body.sessionId })
    assert.equal((await t.api('DELETE', `/api/home/sessions/${second.body.sessionId}`, { token: first.body.token })).body.error, 'SESSION_NOT_FOUND')
  } finally { await t.close() }
})

test('Enforced marker with no row is 503, never Legacy and never 401 (a usage rolled back or not yet loaded)', async () => {
  const t = await setup()
  try {
    await t.front.start()
    await t.login({ setupCode: code(t.prints) })
    const restarted = createHomeFront({ call: async () => { throw new Error('child down') }, markerPath: join(t.dir, 'login-enforced') })
    assert.equal(await restarted.judge({ authorization: 'Bearer anything' }), 'unavailable')
    assert.equal(await restarted.judge({}), 'unavailable')
  } finally { await t.close() }
})

test('console: issue a code, log in as a console session (no pass), list, revoke, reset-owner', async () => {
  const t = await setup()
  try {
    await t.front.start()
    const closeConsole = await t.front.listenConsole(join(t.dir, 'console.sock'))
    const ask = request => new Promise((resolve, reject) => {
      const socket = createConnection(join(t.dir, 'console.sock'))
      let text = ''
      socket.setEncoding('utf8')
      socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
      socket.on('data', chunk => { text += chunk })
      socket.on('end', () => resolve(JSON.parse(text)))
      socket.on('error', reject)
    })
    const { code: issued } = await ask({ op: 'issue' })
    const consoleLogin = await t.api('POST', '/api/home/login/console', { body: { code: issued } })
    assert.equal(consoleLogin.status, 200)
    assert.equal((await t.api('POST', '/api/home/login/console', { body: { code: issued } })).body.error, 'LOGIN_CODE_INVALID') // single use
    assert.equal(t.front.stateOf(consoleLogin.body.sessionId), 'none') // a console session has no contract
    const listed = await ask({ op: 'list' })
    assert.equal(listed.sessions.length, 1)
    const apiList = (await t.api('GET', '/api/home/sessions', { token: consoleLogin.body.token })).body.sessions
    assert.deepEqual([apiList.length, apiList[0].kind, 'passId' in apiList[0], apiList[0].current], [1, 'console', false, true]) // a console row has no pass id (a529m)
    assert.equal((await ask({ op: 'revoke', id: consoleLogin.body.sessionId })).ok, true)
    assert.equal(await t.front.judge({ authorization: `Bearer ${consoleLogin.body.token}` }), 'none')
    assert.equal((await ask({ op: 'nonsense' })).ok, false)
    await ask({ op: 'reset-owner' })
    assert.deepEqual((await t.api('GET', '/api/home/session')).body, { capability: 'login-billing-home/1', bound: false, enforced: true })
    await closeConsole()
  } finally { await t.close() }
})

test('a right setup code is spent even when the proof does not bind (1.22): the host is shown a new code, the old one is dead', async () => {
  const t = await setup({ operatorStatus: { prove: 503, check: 200 } })
  try {
    await t.front.start()
    const spent = code(t.prints)
    const failed = await t.login({ setupCode: spent })
    assert.equal(failed.status, 503) // the operator cannot be reached
    assert.equal(t.prints.length, 2)
    assert.notEqual(code(t.prints), spent)
    t.operator.status.prove = 200
    assert.equal((await t.login({ setupCode: spent })).body.error, 'LOGIN_CODE_INVALID')
    assert.equal((await t.login({ setupCode: code(t.prints) })).status, 200)
  } finally { await t.close() }
})

// The usage child's closed surface (a485): system-only home.* methods, results checked as the channel checks them.
import { createUsageServices } from '../src/usage/services.mjs'
import { usageResultValid } from '../src/usage/process-results.mjs'

const system = { kind: 'system', botId: null }
async function usageFixture(t, environment) {
  const root = await mkdtemp(join(tmpdir(), 'home-login-usage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const service = createUsageServices({ root, bots: new Map(), rooms: new Map(), effect: async () => undefined, onProjection: () => {}, environment })
  await service.initializeSettings(); await service.initialize()
  t.after(async () => { await service.quiesce(); service.close() })
  return { root, service }
}

test('usage child: home.* answers through the closed surface, only for the system, and the row is the one the body keeps', async t => {
  const { root, service } = await usageFixture(t, { BELLTEAM_HOME_OPERATOR: 'https://operator.test/auth/v1' })
  const first = await service.request('home.publish', {}, system)
  assert.equal(usageResultValid('home.publish', first), true)
  assert.deepEqual(first.row, { v: 1, bound: false, enforced: false, hashes: {}, states: {} })
  const nonce = await service.request('home.handle', { method: 'POST', path: '/login/nonce', body: '{}', peer: '192.168.1.5' }, system)
  assert.equal(usageResultValid('home.handle', nonce), true)
  assert.equal(nonce.status, 200)
  assert.equal(Object.hasOwn(nonce, 'row'), true) // present as a key; undefined when unchanged
  assert.equal(nonce.row, undefined)
  const code = await service.request('home.setupCode', {}, system)
  assert.equal(usageResultValid('home.setupCode', code), true)
  assert.equal(usageResultValid('home.sweep', await service.request('home.sweep', { used: [], streaming: [] }, system)), true)
  for (const actor of [{ kind: 'owner', botId: null }, { kind: 'bot', botId: 'bot-a' }]) await assert.rejects(service.request('home.setupCode', {}, actor), { code: 'USAGE_ACTOR_FORBIDDEN' })
  await assert.rejects(service.request('home.handle', { method: 'POST', path: '/x', peer: 'p', headers: { authorization: 'Bearer x' } }, system), { code: 'USAGE_INPUT_INVALID' }) // only the bearer value crosses
  assert.match(await readFile(join(root, 'shared/login-home.json'), 'utf8'), /"nonceSecret"/u)
})

test('usage child: without an operator every home call is unavailable (the body stays Legacy)', async t => {
  const { service } = await usageFixture(t, {})
  await assert.rejects(service.request('home.publish', {}, system), { code: 'SESSION_STORE_UNAVAILABLE' })
  await assert.rejects(service.request('home.handle', { method: 'GET', path: '/session', peer: '' }, system), { code: 'SESSION_STORE_UNAVAILABLE' })
})

test('an open event stream counts as use and is closed when its session ends', async () => {
  const { EventEmitter } = await import('node:events')
  const dir = await mkdtemp(join(tmpdir(), 'home-login-'))
  const sweeps = []
  const rows = [{ v: 1, bound: true, enforced: true, hashes: { h: 's1' }, states: { s1: 'active' } }, { v: 1, bound: true, enforced: true, hashes: {}, states: {} }]
  const front = createHomeFront({ call: async (name, params) => { if (name === 'home.sweep') { sweeps.push(params); return { row: sweeps.length === 1 ? undefined : rows[1] } } return { row: rows[0] } }, markerPath: join(dir, 'm'), setTimer: () => ({ unref() {} }), print() {} })
  try {
    await front.start()
    const response = Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; this.emit('close') } })
    front.trackStream('s1', response)
    await front.tick()
    assert.deepEqual(sweeps.at(-1).streaming, ['s1'])
    assert.equal(response.destroyed, true) // the second answer no longer holds s1
  } finally { await rm(dir, { recursive: true, force: true }) }
})
