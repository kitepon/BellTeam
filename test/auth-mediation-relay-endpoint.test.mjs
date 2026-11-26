import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createConnection } from 'node:net'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuthMediationRelay, relayAnswer, RELAY_SOCKET } from '../src/auth-mediation-relay.mjs'

const recorder = () => {
  const seen = []
  const reply = { outcome: 'granted', env: { A: 'b' }, cache: 'hit' }
  return { seen, facade: {
    containerSocket: async p => (seen.push(['container', p]), reply), hostSocket: async p => (seen.push(['host', p]), reply),
    admin: async p => (seen.push(['admin', p]), { outcome: 'ok' }) }, reply }
}
const peer = { uid: 1000, cwd: '/srv/bellteam/bots/bot-a' }

test('relayAnswer: exec on the container socket uses the peer cwd and ignores the client cwd; the host socket uses the client folder as cwd and unit', async () => {
  const { seen, facade, reply } = recorder()
  assert.deepEqual(await relayAnswer({ via: 'container-socket', peer, request: { op: 'exec', command: ['gh', 'release'], cwd: '/etc' } }, facade), reply)
  assert.deepEqual(seen[0], ['container', { command: ['gh', 'release'], cwd: peer.cwd }])
  assert.deepEqual(await relayAnswer({ via: 'host-socket', peer: null, request: { op: 'exec', command: ['deploy'], cwd: '/home/kite/app' } }, facade), reply)
  assert.deepEqual(seen[1], ['host', { command: ['deploy'], cwd: '/home/kite/app', unit: '/home/kite/app' }])
})

test('relayAnswer: admin only on the container socket with the peer cwd; unknown ops, bad words and bad frames are "Bad request."; a foreign peer is unknown-caller', async () => {
  const { seen, facade } = recorder()
  assert.deepEqual(await relayAnswer({ via: 'container-socket', peer, request: { op: 'admin', verb: 'grant', args: { bot: 'bot-a' } } }, facade), { outcome: 'ok' })
  assert.deepEqual(seen[0], ['admin', { cwd: peer.cwd, verb: 'grant', args: { bot: 'bot-a' } }])
  assert.equal((await relayAnswer({ via: 'host-socket', peer: null, request: { op: 'admin', verb: 'show' } }, facade)).outcome, 'error')
  const bad = { outcome: 'error', error: 'Bad request.' }
  for (const frame of [null, [], { via: 'x', request: {} }, { via: 'container-socket', peer, request: { op: 'flush' } }, { via: 'container-socket', peer, request: { op: 'exec', command: [] } },
    { via: 'container-socket', peer, request: { op: 'exec', command: [1] } }, { via: 'host-socket', peer: null, request: { op: 'exec', command: ['a'] } },
    { via: 'host-socket', peer, request: { op: 'exec', command: ['a'], cwd: '/x' } }, { via: 'container-socket', peer, request: { op: 'admin', verb: 'Bad Verb' } },
    { via: 'container-socket', peer, request: { op: 'admin', verb: 'show', args: [] } }, { via: 'container-socket', peer }])
    assert.deepEqual(await relayAnswer(frame, facade), bad, JSON.stringify(frame))
  for (const foreign of [null, { uid: 0, cwd: '/x' }, { uid: 1001, cwd: '/x' }, { uid: 1000, cwd: 'rel' }])
    assert.equal((await relayAnswer({ via: 'container-socket', peer: foreign, request: { op: 'exec', command: ['a'] } }, facade)).outcome, 'unknown-caller')
  assert.equal(seen.length, 1, 'no facade call for a refused frame')
})

const ask = (path, text) => new Promise((resolve, reject) => {
  const socket = createConnection(path); let out = ''
  socket.setEncoding('utf8'); socket.on('data', c => out += c); socket.on('end', () => resolve(out)); socket.on('error', reject)
  socket.on('connect', () => socket.write(text))
})

test('the endpoint answers one frame per connection on its unix socket (0666), refuses a long or broken frame, and answers "Timed out." when the module is too slow', async t => {
  const root = await mkdtemp(join(tmpdir(), 'auth-relay-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { facade } = recorder()
  const relay = createAuthMediationRelay({ root, facade: { ...facade, hostSocket: () => new Promise(() => {}) }, spawn: () => { throw new Error('no relay in this test') }, answerMs: 50 })
  await relay.start()
  t.after(() => relay.close())
  assert.equal(relay.path, join(root, 'state', RELAY_SOCKET))
  assert.equal((await stat(relay.path)).mode & 0o777, 0o666)
  const ok = JSON.parse(await ask(relay.path, JSON.stringify({ via: 'container-socket', peer, request: { op: 'exec', command: ['gh'] } }) + '\n'))
  assert.equal(ok.outcome, 'granted')
  assert.deepEqual(JSON.parse(await ask(relay.path, 'not json\n')), { outcome: 'error', error: 'Bad request.' })
  assert.deepEqual(JSON.parse(await ask(relay.path, 'x'.repeat(130 * 1024))), { outcome: 'error', error: 'Bad request.' })
  assert.deepEqual(JSON.parse(await ask(relay.path, JSON.stringify({ via: 'host-socket', peer: null, request: { op: 'exec', command: ['d'], cwd: '/h' } }) + '\n')), { outcome: 'error', error: 'Timed out.' })
  assert.deepEqual(relay.status(), { listening: true, relay: false })
})

test('supervision: the relay is started as the seat uid through the privileged entry, waits for its ready line; close stops it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'auth-relay-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const children = [], specs = []
  const spawn = (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.exitCode = null; child.signalCode = null
    child.kill = signal => { child.signalCode = signal; setImmediate(() => child.emit('exit', null, signal)); return true }
    children.push(child); specs.push([command, args, options.stdio]); setImmediate(() => child.stdout.write('auth-mediation relay ready\n'))
    return child
  }
  const relay = createAuthMediationRelay({ root, facade: recorder().facade, spawn, relayScript: '/app/scripts/auth-mediation/relay.py' })
  await relay.start()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(children.length, 1)
  assert.equal(specs[0][0], 'sudo')
  assert.ok(specs[0][1].includes('/usr/local/libexec/bellteam-seat-exec') && specs[0][1].includes('--base-environment') && specs[0][1].includes('/usr/bin/python3') && specs[0][1].includes('/app/scripts/auth-mediation/relay.py'))
  assert.deepEqual(relay.status(), { listening: true, relay: true })
  await relay.close()
  assert.equal(children[0].signalCode, 'SIGTERM')
  assert.deepEqual(relay.status(), { listening: false, relay: false })
})
