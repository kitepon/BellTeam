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

test('credential refresh: rejected report is contained and stop waits for the in-flight refresh', async () => {
  const { createCredentialRefresh } = await import('../src/secret-credential-refresh.mjs')
  let release, finished = false
  const unhandled = []
  const onUnhandled = reason => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const helper = createCredentialRefresh({ watch: () => () => {},
      refresh: () => new Promise((_resolve, reject) => { release = () => reject(new Error('PROVIDER_DOWN')) }),
      report: async () => { throw new Error('DIAGNOSTICS_CLOSED') } })
    const inflight = helper.refreshNow()
    const stopped = helper.stop().then(() => { finished = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(finished, false)
    release()
    await stopped
    await inflight
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(finished, true)
    assert.deepEqual(unhandled, [])
  } finally { process.off('unhandledRejection', onUnhandled) }
})

test('credential refresh: recoveryNeeded without handles arms the timer until refresh reports recovery', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { createCredentialRefresh } = await import('../src/secret-credential-refresh.mjs')
  const results = [{ recoveryNeeded: true }, { recoveryNeeded: true }, { recoveryNeeded: false }]
  let calls = 0, recoveryListener
  const helper = createCredentialRefresh({ refresh: async () => results[calls++], watch: () => () => {},
    watchRecovery: listener => { recoveryListener = listener; return () => { recoveryListener = null } }, intervalMs: 1000 })
  await helper.refreshNow()
  assert.equal(helper.pending, 1)
  const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
  t.mock.timers.tick(1000); await settle()
  t.mock.timers.tick(1000); await settle()
  assert.equal(calls, 3)
  assert.equal(helper.pending, 0)
  t.mock.timers.tick(5000); await settle()
  assert.equal(calls, 3)
  recoveryListener({ recoveryNeeded: true })
  t.mock.timers.tick(1000); await settle()
  assert.equal(calls, 4)
  await helper.stop()
  assert.equal(recoveryListener, null)
})

test('remote seat listener: loopback server serves only the two seat MCP paths', async t => {
  const { createRemoteSeatServer } = await import('../src/seat-mcp.mjs')
  const seen = []
  const server = createRemoteSeatServer(async (request, response, url) => { seen.push(url.pathname); response.end('ok') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  assert.equal(await (await fetch(base + '/api/seat-mcp', { method: 'POST' })).text(), 'ok')
  assert.equal(await (await fetch(base + '/api/seat-mcp/call-bridge?x=1', { method: 'POST' })).text(), 'ok')
  for (const path of ['/api/queue', '/mcp', '/api/seat-mcp/other', '/healthz']) assert.equal((await fetch(base + path)).status, 404)
  assert.deepEqual(seen, ['/api/seat-mcp', '/api/seat-mcp/call-bridge'])
})

test('native credential status: one-shot bin, exit 0/2 DTOs as-is, anything else unavailable', async () => {
  const { remoteTerminalStatus } = await import('../src/application-services.mjs')
  const ref = '725ca83c-f52f-4036-9390-8d9e4c482f14'
  const calls = []
  const runner = result => async (command, args, options) => { calls.push({ command, args, options }); if (result instanceof Error) throw result; return result }
  const ok = { schema: 'aiterm.remote-binding-status.v1', ref }
  assert.deepEqual(await remoteTerminalStatus('/x', ref, runner({ code: 0, signal: null, stdout: JSON.stringify(ok) + '\n' })), ok)
  assert.deepEqual(calls[0], { command: '/usr/bin/env', args: ['aiterm-remote-terminal', 'status', '--ref', ref], options: { acceptNonzero: true, maxBuffer: 65536 } })
  const error = { schema: 'aiterm.remote-binding-error.v1', code: 'REMOTE_BINDING_NOT_FOUND' }
  assert.deepEqual(await remoteTerminalStatus('/x', ref, runner({ code: 2, signal: null, stdout: JSON.stringify(error) })), error)
  for (const result of [{ code: 1, signal: null, stdout: '{}' }, { code: null, signal: 'SIGTERM', stdout: '' }, { code: 0, signal: null, stdout: 'not json' },
    { code: 0, signal: null, stdout: '[]' }, { code: 0, signal: null, stdout: 'null' }, new Error('spawn ENOENT')])
    await assert.rejects(remoteTerminalStatus('/x', ref, runner(result)), { code: 'REMOTE_TERMINAL_STATUS_UNAVAILABLE' })
})

test('bind_terminal_key: target from the record, handle becomes sshKeyRef, typed errors', async () => {
  const { callTerminalTool, createTerminalKeys } = await import('../src/terminals-mcp.mjs')
  const ref = '725ca83c-f52f-4036-9390-8d9e4c482f14'
  const puts = [], registrations = []
  const record = { terminalId: 'owner-macbook', host: '192.168.1.12', user: 'kite', port: 22 }
  const core = { registry: { get: async id => (id === record.terminalId ? record : null), put: async input => { puts.push(input); return { ...record, sshKeyConfigured: true } } } }
  const credentials = { registerNative: async (binding, scope) => { registrations.push({ binding, scope }); return { handle: 'h-1', revision: 1, available: true } } }
  const keys = createTerminalKeys({ terminals: core, credentials })
  const result = await callTerminalTool({ name: 'bind_terminal_key', args: { terminalId: 'owner-macbook', ref }, terminals: () => core, terminalKeys: () => keys })
  assert.deepEqual(result.credential, { handle: 'h-1', revision: 1, available: true })
  assert.deepEqual(registrations, [{ binding: { ref, target: { host: '192.168.1.12', user: 'kite', port: 22 } }, scope: { terminalId: 'owner-macbook', purpose: 'terminal.ssh' } }])
  assert.deepEqual(puts, [{ terminalId: 'owner-macbook', sshKeyRef: 'h-1' }])
  await assert.rejects(callTerminalTool({ name: 'bind_terminal_key', args: { terminalId: 'nope', ref }, terminals: () => core, terminalKeys: () => keys }), { code: 'TERMINAL_NOT_FOUND' })
  await assert.rejects(callTerminalTool({ name: 'bind_terminal_key', args: { terminalId: 'owner-macbook', ref, host: 'evil' }, terminals: () => core, terminalKeys: () => keys }), /TOOL_ARGUMENT_INVALID/)
  await assert.rejects(callTerminalTool({ name: 'bind_terminal_key', args: { terminalId: 'owner-macbook', ref }, terminals: () => core, terminalKeys: () => null }), { code: 'CREDENTIAL_UNAVAILABLE' })
})

test('terminal key load: value only on the bin stdin, receipt or binding error, invalid input refused before resolve', async () => {
  const { loadTerminalKey } = await import('../src/application-services.mjs')
  const ref = '725ca83c-f52f-4036-9390-8d9e4c482f14', handle = '11111111-2222-4333-8444-555555555555', key = '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n'
  const resolved = []
  const credentials = { withResolved: async (h, context, consume) => { resolved.push({ h, context }); return consume(key) } }
  const calls = []
  const runner = result => async (command, args, options) => { calls.push({ command, args, input: options.input.toString('utf8'), options: { ...options, input: undefined } }); return result }
  const receipt = { schema: 'aiterm.credential-load.v1', accepted: true }
  const base = { credentials, terminalId: 'owner-macbook', memberId: 'bot-aa', ref, handle, revision: 3 }
  assert.deepEqual(await loadTerminalKey({ ...base, run: runner({ code: 0, signal: null, stdout: JSON.stringify(receipt) }) }), receipt)
  assert.deepEqual(resolved, [{ h: handle, context: { terminalId: 'owner-macbook', memberId: 'bot-aa', purpose: 'terminal.ssh', expectedRevision: 3 } }])
  assert.deepEqual(calls[0].args, ['aiterm-remote-terminal', 'credential-load', '--ref', ref, '--terminal-id', 'owner-macbook', '--handle', handle, '--revision', '3', '--purpose', 'ssh-key'])
  assert.equal(calls[0].input, key); assert.ok(!calls[0].args.some(arg => arg.includes('PRIVATE')))
  await assert.rejects(loadTerminalKey({ ...base, run: runner({ code: 2, signal: null, stdout: JSON.stringify({ schema: 'aiterm.remote-binding-error.v1', code: 'REMOTE_BINDING_NOT_FOUND' }) }) }), { code: 'REMOTE_BINDING_NOT_FOUND', status: 409 })
  for (const result of [{ code: 1, signal: null, stdout: '{}' }, { code: 0, signal: null, stdout: '{"schema":"other"}' }, { code: null, signal: 'SIGTERM', stdout: '' }])
    await assert.rejects(loadTerminalKey({ ...base, run: runner(result) }), { code: 'TERMINAL_KEY_LOAD_UNAVAILABLE' })
  resolved.length = 0
  for (const bad of [{ ref: 'x' }, { handle: 'x' }, { revision: 0 }, { revision: 1.5 }, { terminalId: 'Bad' }, { memberId: 7 }])
    await assert.rejects(loadTerminalKey({ ...base, ...bad, run: runner({}) }), { code: 'TERMINAL_KEY_LOAD_INVALID' })
  assert.equal(resolved.length, 0)
  await assert.rejects(loadTerminalKey({ ...base, credentials: null, run: runner({}) }), { code: 'CREDENTIAL_UNAVAILABLE' })
})
