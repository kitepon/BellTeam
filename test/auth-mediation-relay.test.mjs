import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, stat } from 'node:fs/promises'
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

test('run: the relay joins the caller to the module child\'s stream socket and the real client pipes bytes in, frames out, with the command\'s exit code', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-')), bodyPath = join(dir, 'body.sock'), seen = []
  const body = createServer(c => { let buf = ''; c.on('data', d => { buf += d; if (!buf.includes('\n')) return
    const frame = JSON.parse(buf); seen.push(frame); c.end(JSON.stringify({ outcome: 'granted' }) + '\n')
    // the module child: joins the stream, uppercases what comes in, answers in frames, then the exit code
    const s = connect({ path: frame.stream, allowHalfOpen: true }); const out = (tag, data) => { const h = Buffer.alloc(5); h[0] = tag; h.writeUInt32BE(data.length, 1); s.write(Buffer.concat([h, data])) }
    s.on('data', d => out(1, Buffer.from(d.toString().toUpperCase()))); s.on('end', () => { out(2, Buffer.from('warn')); out(3, Buffer.from('7')); s.end() }) }) })
  await new Promise(r => body.listen(bodyPath, r))
  const relay = spawn(RELAY, [], { env: { ...process.env, AUTH_RELAY_DIR: join(dir, 'share'), AUTH_RELAY_BODY: bodyPath, AUTH_RELAY_SEAT_UID: String(process.getuid()) } })
  try {
    await new Promise(resolve => relay.stdout.once('data', resolve))
    const AUTHC = new URL('../scripts/auth-mediation/auth', import.meta.url).pathname
    const result = await new Promise(resolve => { const c = spawn('python3', ['-I', AUTHC, 'run', 'upper'], { env: { ...process.env, AUTH_SOCK: join(dir, 'share', 'container.sock') } }); let out = '', err = ''
      c.stdout.on('data', d => { out += d }); c.stderr.on('data', d => { err += d }); c.on('close', code => resolve({ code, out, err })); c.stdin.end('hello stream') })
    assert.deepEqual(result, { code: 7, out: 'HELLO STREAM', err: 'warn' })
    assert.equal(seen[0].request.op, 'run'); assert.match(seen[0].stream, /\/share\/runs\/[0-9a-f-]{36}\.sock$/u); assert.equal(seen[0].via, 'container-socket')
    assert.equal((await stat(join(dir, 'share', 'runs'))).mode & 0o777, 0o711)
  } finally { relay.kill('SIGTERM'); body.close() }
})

test('caller sockets: an ordinary caller is 0666 in a 0755 folder; a restricted caller (bellteam-push) is 0660 and its prepared folder is left as the host made it; the unit is the socket path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-')), bodyPath = join(dir, 'body.sock'), frames = []
  const body = createServer(c => { let buf = ''; c.on('data', d => { buf += d; if (buf.includes('\n')) { frames.push(JSON.parse(buf)); c.end(JSON.stringify({ outcome: 'granted', data: 'sig' }) + '\n') } }) })
  await new Promise(r => body.listen(bodyPath, r))
  const share = join(dir, 'share'), folder = join(share, 'callers', 'bellteam-push'); await mkdir(folder, { recursive: true, mode: 0o700 }); await chmod(folder, 0o2750) // what the host prepares once
  const relay = spawn(RELAY, [], { env: { ...process.env, AUTH_RELAY_DIR: share, AUTH_RELAY_BODY: bodyPath, AUTH_RELAY_SEAT_UID: String(process.getuid()) } })
  try {
    await new Promise(resolve => relay.stdout.once('data', resolve))
    const mode = async p => (await stat(p)).mode & 0o7777
    assert.equal(await mode(join(share, 'callers', 'mmobank', 'mmobank.sock')), 0o666); assert.equal(await mode(join(share, 'callers', 'mmobank')), 0o755)
    assert.equal(await mode(join(folder, 'bellteam-push.sock')), 0o660); assert.equal(await mode(folder), 0o2750)
    const answer = await new Promise((resolve, reject) => { const c = connect(join(folder, 'bellteam-push.sock')); let out = ''; c.on('connect', () => c.write(line({ op: 'sign', name: 'apns', data: 'AA==' }))); c.on('data', d => { out += d }); c.on('end', () => resolve(out)); c.on('error', reject) })
    assert.equal(JSON.parse(answer).outcome, 'granted'); assert.equal(frames[0].via, 'caller-socket'); assert.equal(frames[0].unit, join(share, 'callers', 'bellteam-push', 'bellteam-push.sock'))
  } finally { relay.kill('SIGTERM'); body.close() }
})
