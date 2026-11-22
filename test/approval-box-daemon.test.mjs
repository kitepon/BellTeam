import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApprovalBoxDaemon, localCall, stunProbe, egressCheck } from '../src/approval-box-daemon.mjs'
import { callApprovalBoxDaemonTool, approvalBoxDaemonTools, APPROVAL_BOX_PAIRING_BOT } from '../src/approval-box-daemon-mcp.mjs'
import { bellTeamTools } from '../src/mcp-tools.mjs'

// A fake package entry that speaks the real contract: `daemon --hosted` serves NDJSON on HOME/state/pc/daemon.sock; `pair --json` prints lines.
const FAKE = `
import net from 'node:net'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const [command, ...rest] = process.argv.slice(2)
const home = process.env.APPROVAL_BOX_HOME
if (command === 'daemon') {
  mkdirSync(join(home, 'state', 'pc'), { recursive: true, mode: 0o700 })
  writeFileSync(join(home, 'env-keys.json'), JSON.stringify(Object.keys(process.env).sort()))
  const path = join(home, 'state', 'pc', 'daemon.sock'); rmSync(path, { force: true })
  net.createServer(socket => { let t = ''; socket.setEncoding('utf8'); socket.on('data', c => { t += c; if (!t.includes('\\n')) return
    const { method, path: route } = JSON.parse(t.split('\\n')[0])
    socket.end(JSON.stringify(route === '/status' ? { ok: true, result: { schema: 'x', mode: 'not_paired', paired: false, reason: 'not_paired', version: '0.2.0-pc.1', pid: process.pid } }
      : route === '/decisions' ? { ok: true, result: { items: [] } } : { ok: false, status: 404, code: 'not_found', message: 'x' }) + '\\n') }) }).listen(path)
  process.stderr.write('daemon up secret-looking-text-should-be-masked-' + 'x'.repeat(50) + '\\n')
  setInterval(() => {}, 1000)
} else if (command === 'pair') {
  const out = line => process.stdout.write(JSON.stringify(line) + '\\n')
  out({ type: 'waiting', code: 'ABCD-EFGH-IJKL-MNOP', typed_secret: 'TYPED-SECRET', qr_text: 'QR-TEXT-SECRET', expires_at: '2026-11-29T00:00:00Z', rebind: rest.includes('--rebind') })
  setTimeout(() => out({ type: 'claimed', claimed_at: '2026-11-22T10:00:00Z' }), 300)
  setTimeout(() => { out({ type: 'bound', connection_id: 'conn-1' }); process.exit(0) }, 600)
}
`
async function setup(t, { missing = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'abd-'))
  const entry = join(root, 'cli.mjs')
  if (!missing) await writeFile(entry, FAKE)
  const daemon = createApprovalBoxDaemon({ root, entry })
  t.after(async () => { await daemon.close(); await rm(root, { recursive: true, force: true }) })
  return { root, entry, daemon }
}
const until = async (check, ms = 8000) => { const end = Date.now() + ms; for (;;) { const value = await check(); if (value) return value; if (Date.now() > end) throw new Error('until timed out'); await new Promise(r => setTimeout(r, 50)) } }

test('start does not wait, the child answers /status over its socket, the home is 0700 and the child env is closed', async t => {
  const { daemon, root } = await setup(t)
  const begun = Date.now()
  daemon.start()
  assert.ok(Date.now() - begun < 500, 'start() returned at once')
  const status = await until(async () => { const s = await daemon.status(); return s.reachable ? s : null })
  assert.deepEqual({ ...status.daemon }, { mode: 'not_paired', paired: false, reason: 'not_paired', version: '0.2.0-pc.1' })
  assert.equal((await stat(daemon.home)).mode & 0o777, 0o700)
  const keys = JSON.parse(await readFile(join(daemon.home, 'env-keys.json'), 'utf8'))
  for (const key of keys) assert.ok(['APPROVAL_BOX_HOME', 'APPROVAL_BOX_SERVER', 'HOME', 'LANG', 'PATH', 'PWD', 'SHLVL', '_', 'OLDPWD'].includes(key), `unexpected env key ${key}`)
  assert.deepEqual(await daemon.route('GET', '/decisions'), { items: [] })
  await assert.rejects(daemon.route('GET', '/nope'), { code: 'not_found', status: 404 })
  assert.equal(root.length > 0, true)
})

test('a killed child is restarted by itself and the log keeps masked lines only', async t => {
  const { daemon, root } = await setup(t)
  daemon.start()
  const first = await until(async () => { const s = await daemon.status(); return s.reachable ? s : null })
  assert.equal(first.running, true)
  const before = (await localCall(daemon.socketPath, 'GET', '/status')).result.pid
  process.kill(before, 'SIGKILL')
  const after = await until(async () => { try { const pid = (await localCall(daemon.socketPath, 'GET', '/status')).result.pid; return pid !== before ? pid : null } catch { return null } }, 12000)
  assert.notEqual(after, before)
  await daemon.close()
  const log = await readFile(join(root, 'state', 'approval-box-daemon-stderr.jsonl'), 'utf8')
  assert.match(log, /daemon up/); assert.doesNotMatch(log, /x{50}/)
})

test('pairing returns the waiting line once, never logs it, and reports claimed then bound without the secrets', async t => {
  const { daemon, root } = await setup(t)
  daemon.start()
  await until(async () => (await daemon.status()).reachable)
  const waiting = await daemon.pair()
  assert.equal(waiting.typed_secret, 'TYPED-SECRET'); assert.equal(waiting.qr_text, 'QR-TEXT-SECRET'); assert.equal(waiting.rebind, false)
  assert.deepEqual(await daemon.pair(), waiting) // a second ask while it runs returns the same line
  const bound = await until(async () => { const s = daemon.pairStatus(); return s.state === 'bound' ? s : null })
  assert.deepEqual(bound.lines.map(line => line.type), ['waiting', 'claimed', 'bound'])
  assert.doesNotMatch(JSON.stringify(bound), /SECRET|ABCD-EFGH/)
  assert.equal((await daemon.status()).pairing.lines.length, 3)
  await daemon.close()
  const log = await readFile(join(root, 'state', 'approval-box-daemon-stderr.jsonl'), 'utf8').catch(() => '')
  assert.doesNotMatch(log, /SECRET|ABCD-EFGH/)
})

test('a package that is not in the image is a no-op: no child, status says unavailable, pairing is refused', async t => {
  const { daemon } = await setup(t, { missing: true })
  daemon.start()
  assert.deepEqual(await daemon.status(), { available: false, running: false, daemon: null })
  await assert.rejects(daemon.pair(), { code: 'APPROVAL_BOX_DAEMON_UNAVAILABLE' })
  await assert.rejects(daemon.route('GET', '/status'), { code: 'APPROVAL_BOX_DAEMON_UNAVAILABLE' })
})

test('the MCP tools are the body\'s own Bot only, never a fork, and run through the controller', async t => {
  const { daemon } = await setup(t)
  daemon.start()
  await until(async () => (await daemon.status()).reachable)
  for (const tool of approvalBoxDaemonTools) assert.ok(bellTeamTools.some(item => item.name === tool.name))
  await assert.rejects(callApprovalBoxDaemonTool({ name: 'approval_box_pair', from: 'bot-someone-else', approvalBoxDaemon: daemon }), { code: 'APPROVAL_BOX_DAEMON_NOT_ALLOWED' })
  await assert.rejects(callApprovalBoxDaemonTool({ name: 'approval_box_pair', from: APPROVAL_BOX_PAIRING_BOT, fork: true, approvalBoxDaemon: daemon }), { code: 'APPROVAL_BOX_DAEMON_NOT_ALLOWED' })
  await assert.rejects(callApprovalBoxDaemonTool({ name: 'approval_box_pair', from: APPROVAL_BOX_PAIRING_BOT, approvalBoxDaemon: null }), { code: 'APPROVAL_BOX_DAEMON_UNAVAILABLE' })
  const status = await callApprovalBoxDaemonTool({ name: 'approval_box_daemon_status', args: {}, from: APPROVAL_BOX_PAIRING_BOT, approvalBoxDaemon: daemon })
  assert.equal(status.daemon.mode, 'not_paired')
  const { waiting } = await callApprovalBoxDaemonTool({ name: 'approval_box_pair', args: { rebind: true }, from: APPROVAL_BOX_PAIRING_BOT, approvalBoxDaemon: daemon })
  assert.equal(waiting.rebind, true)
  await assert.rejects(callApprovalBoxDaemonTool({ name: 'approval_box_pair', args: { extra: 1 }, from: APPROVAL_BOX_PAIRING_BOT, approvalBoxDaemon: daemon }))
})

test('the egress probe answers ok only for a STUN reply with the same transaction id, and times out otherwise', async () => {
  const sockets = []
  const fakeDgram = (reply) => () => {
    const handlers = {}
    const socket = { on: (name, fn) => { handlers[name] = fn }, close: () => {}, send: (buffer, port, host, cb) => {
      cb?.(); if (!reply) return
      const answer = Buffer.alloc(20); answer[0] = 1; answer[1] = 1; buffer.copy(answer, 4, 4, 20)
      if (reply === 'wrong') answer[10] ^= 0xff
      setImmediate(() => handlers.message(answer)) } }
    sockets.push(socket); return socket
  }
  assert.equal(await stunProbe('x', 3478, { dgram: fakeDgram('right'), timeoutMs: 200 }), 'ok')
  assert.equal(await stunProbe('x', 3478, { dgram: fakeDgram('wrong'), timeoutMs: 100 }), 'timeout')
  assert.equal(await stunProbe('x', 3478, { dgram: fakeDgram(null), timeoutMs: 100 }), 'timeout')
  const result = await egressCheck({ udp: { dgram: fakeDgram('right'), timeoutMs: 100 }, tcp: { connect: () => ({ once: (name, fn) => { if (name === 'connect') setImmediate(fn) }, destroy: () => {} }), timeoutMs: 100 } })
  assert.equal(result.allOk, true); assert.equal(result.targets.length, 4)
})

test('the entry path, the Dockerfile step and the pin agree on one package version', async () => {
  const { DAEMON_ENTRY } = await import('../src/approval-box-daemon.mjs')
  const [dockerfile, pin, lock] = await Promise.all(['../Dockerfile', '../distribution/approval-box/package.json', '../distribution/approval-box/package-lock.json']
    .map(path => readFile(new URL(path, import.meta.url), 'utf8')))
  const version = JSON.parse(pin).dependencies['approval-box']
  assert.match(version, /^\d+\.\d+\.\d+-pc\.\d+$/) // exact, no range
  assert.equal(JSON.parse(lock).packages['node_modules/approval-box'].version, version)
  assert.match(JSON.parse(lock).packages['node_modules/approval-box'].integrity, /^sha512-/)
  assert.equal(DAEMON_ENTRY, `/app/distribution/approval-box/runtime-home/runtime/${version}/cli.mjs`)
  assert.ok(dockerfile.includes('APPROVAL_BOX_HOME=/app/distribution/approval-box/runtime-home') && dockerfile.includes(`runtime/${version}/cli.mjs`))
})
