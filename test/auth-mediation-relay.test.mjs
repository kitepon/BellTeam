import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, stat } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const RELAY = new URL('../scripts/auth-mediation/relay.py', import.meta.url).pathname

async function start({ uid = process.getuid(), body = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-')), bodyPath = join(dir, 'body.sock'), frames = []
  let server
  if (body) {
    server = createServer(c => { let buf = ''; c.on('data', d => { buf += d; if (buf.includes('\n')) { frames.push(JSON.parse(buf)); c.end(JSON.stringify({ outcome: 'granted', env: { A: '1' } }) + '\n') } }) })
    await new Promise(r => server.listen(bodyPath, r))
  }
  const child = spawn(RELAY, [], { env: { ...process.env, AUTH_RELAY_DIR: join(dir, 'share'), AUTH_RELAY_BODY: bodyPath, AUTH_RELAY_SEAT_UID: String(uid) } })
  await new Promise(resolve => child.stdout.once('data', resolve))
  const ask = (name, text) => new Promise((resolve, reject) => {
    const c = connect(join(dir, 'share', name)); let out = ''
    c.on('connect', () => c.write(text)); c.on('data', d => { out += d }); c.on('end', () => resolve(out)); c.on('error', reject)
  })
  return { ask, frames, dir, stop: () => { child.kill('SIGTERM'); server?.close() } }
}
const line = o => JSON.stringify(o) + '\n'

test('container socket adds the peer uid and cwd; host socket adds none; reply is the body line unchanged', async () => {
  const r = await start()
  try {
    const req = { op: 'exec', command: ['gh', 'x'], cwd: '/ignored' }
    assert.deepEqual(JSON.parse(await r.ask('container.sock', line(req))), { outcome: 'granted', env: { A: '1' } })
    assert.deepEqual(r.frames[0], { via: 'container-socket', peer: { uid: process.getuid(), cwd: process.cwd() }, request: req })
    await r.ask('host.sock', line({ op: 'exec', command: ['d'], cwd: '/home/kite/x' }))
    assert.deepEqual(r.frames[1], { via: 'host-socket', peer: null, request: { op: 'exec', command: ['d'], cwd: '/home/kite/x' } })
    assert.equal((await stat(join(r.dir, 'share', 'host.sock'))).mode & 0o777, 0o600)
    assert.equal((await stat(join(r.dir, 'share', 'container.sock'))).mode & 0o777, 0o666)
    assert.equal((await stat(join(r.dir, 'share'))).mode & 0o777, 0o711)
  } finally { r.stop() }
})

test('an admin request also carries the peer program (read by the relay); an exec request does not', async () => {
  const r = await start()
  try {
    await r.ask('container.sock', line({ op: 'admin', verb: 'show' }))
    await r.ask('container.sock', line({ op: 'exec', command: ['a'], cwd: '/' }))
    assert.ok('program' in r.frames[0].peer); assert.equal(r.frames[0].peer.uid, process.getuid())
    assert.ok(r.frames[0].peer.program === null || (r.frames[0].peer.program.sealed === false && /^[a-f0-9]{64}$/u.test(r.frames[0].peer.program.sha256))) // the test runner is a seat-owned program: never sealed
    assert.ok(!('program' in r.frames[1].peer))
  } finally { r.stop() }
})

test('framing: bad JSON, not an object and over 64 KiB all end as Bad request', async () => {
  const r = await start()
  try {
    for (const text of ['nope\n', '[1]\n', 'x'.repeat(70000) + '\n'])
      assert.deepEqual(JSON.parse(await r.ask('host.sock', text)), { outcome: 'error', error: 'Bad request.' })
    assert.equal(r.frames.length, 0)
  } finally { r.stop() }
})

test('a peer that is not the seat uid is unknown-caller on the container socket; no body = module not running', async () => {
  const wrong = await start({ uid: process.getuid() + 1 })
  try {
    assert.equal(JSON.parse(await wrong.ask('container.sock', line({ op: 'exec', command: ['a'], cwd: '/' }))).outcome, 'unknown-caller')
    assert.equal(wrong.frames.length, 0)
  } finally { wrong.stop() }
  const down = await start({ body: false })
  try { assert.match(JSON.parse(await down.ask('host.sock', line({ op: 'exec', command: ['a'], cwd: '/' }))).error, /not running/u) }
  finally { down.stop() }
})
