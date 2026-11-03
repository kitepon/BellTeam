import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createDiagnosticsParentChannel } from '../src/diagnostics-ipc.mjs'
import { DIAGNOSTICS_STATE_COMPATIBILITY } from '../src/diagnostics-protocol.mjs'
import { waitNotificationsChildClose } from '../src/notifications-ipc.mjs'

const generation = 'builtin:fixture'
const report = { code: 'SERVER_HTTP_503', module: 'server', diagnostic_log: 'code=unknown' }
const tick = () => new Promise(setImmediate)
async function start(t, populate) {
  const root = await mkdtemp(join(tmpdir(), 'diagnostics-ipc-'))
  await populate?.(root)
  const child = spawn(process.execPath, [new URL('./fixtures/diagnostics-runtime-child.mjs', import.meta.url).pathname, root], {
    env: {}, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced',
  })
  const ended = waitNotificationsChildClose(child)
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes })
  const channel = createDiagnosticsParentChannel(child, { generation })
  t.after(async () => { child.kill('SIGKILL'); await ended; channel.reaped(); await rm(root, { recursive: true, force: true }) })
  assert.deepEqual(await channel.control('initialize', { generation, mode: 'restore' }, 45000), { stateCompatibility: DIAGNOSTICS_STATE_COMPATIBILITY })
  assert.deepEqual(await channel.ready, { versionId: null, protocolVersion: 1, stateCompatibility: DIAGNOSTICS_STATE_COMPATIBILITY })
  return { root, channel, ended, stderr: () => stderr }
}

test('actual IPC gates new roots, saves report/notes, returns list array and closes after exit result', { timeout: 15000 }, async t => {
  const x = await start(t)
  await assert.rejects(x.channel.request('record', { report }), { outcome: 'not_accepted' })
  await x.channel.control('resume')
  const write = x.channel.request('record', { report })
  assert.equal(typeof write.completion.then, 'function')
  const row = await write
  await write.completion
  assert.equal(row.occurrence_count, 1)
  assert.deepEqual(JSON.parse(await readFile(join(x.root, 'logs/diagnostics.json'), 'utf8')), [row])
  const missing = x.channel.request('setNote', { fingerprint: '0'.repeat(64), note: '根拠' })
  await assert.rejects(missing, { code: 'DIAGNOSTIC_NOT_FOUND', status: 404 })
  await assert.rejects(missing.completion, { code: 'DIAGNOSTIC_NOT_FOUND' })
  await x.channel.request('setStatus', { fingerprint: row.fingerprint, status: 'resolved', note: '根拠' })
  const list = x.channel.request('list', { status: 'resolved' })
  const [listed] = await list
  await list.completion
  assert.equal(listed.fingerprint, row.fingerprint)
  assert.equal(listed.diagnostic_context.investigation_note.summary, '根拠')
  assert.equal(x.channel.snapshot().root, 0)
  assert.deepEqual(await x.channel.control('quiesce', {}, 60000), { quiesced: true })
  await assert.rejects(x.channel.request('record', { report }), { outcome: 'not_accepted' })
  await x.channel.control('exit')
  assert.deepEqual(await x.ended, { code: 0, signal: null })
  assert.equal(x.stderr(), '')
})

test('history stream preserves escaped list above 96MiB without aggregate result frame or content truncation', { timeout: 30000 }, async t => {
  const log = '\0'.repeat(49151) + 'x'
  const rows = Array.from({ length: 350 }, (_, i) => ({
    fingerprint: createHash('sha256').update(String(i)).digest('hex'), severity: 'warn', message_template: 'fixture',
    category: report.code, module: 'server', occurrence_count: 1, last_seen: new Date(i).toISOString(), status: 'open', diagnostic_log: log,
  }))
  const raw = JSON.stringify(rows)
  assert.ok(Buffer.byteLength(raw) > 96 * 1024 * 1024)
  const x = await start(t, async root => { await mkdir(join(root, 'logs')); await writeFile(join(root, 'logs/diagnostics.json'), raw) })
  await x.channel.control('resume')
  const reading = x.channel.request('list', { limit: 1000 })
  const returned = await reading
  await reading.completion
  assert.equal(returned.length, rows.length)
  for (let i = 0; i < returned.length; i++) {
    assert.equal(returned[i].fingerprint, rows[rows.length - 1 - i].fingerprint)
    assert.equal(returned[i].diagnostic_log, log)
  }
  assert.equal(x.channel.snapshot().root, 0)
  assert.deepEqual(await x.channel.control('quiesce', {}, 60000), { quiesced: true })
  await x.channel.control('exit')
  assert.deepEqual(await x.ended, { code: 0, signal: null })
})

test('caller timeout retains all eight actual completions until reply or reaped', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  class Endpoint extends EventEmitter {
    connected = true
    sent = []
    send(frame, callback) { this.sent.push(frame); callback?.() }
    disconnect() { if (this.connected) { this.connected = false; this.emit('disconnect') } }
  }
  const endpoint = new Endpoint(), channel = createDiagnosticsParentChannel(endpoint, { generation })
  const attempts = Array.from({ length: 8 }, () => channel.request('record', { report }))
  const rejected = attempts.map(attempt => assert.rejects(attempt, { outcome: 'unknown' }))
  for (const frame of endpoint.sent) endpoint.emit('message', { type: 'accepted', kind: 'root', id: frame.id })
  let terminated = 0
  for (const attempt of attempts) void attempt.completion.then(() => terminated++, () => terminated++)
  t.mock.timers.tick(60000)
  await Promise.all(rejected)
  assert.equal(terminated, 0)
  assert.equal(channel.snapshot().root, 8)
  await assert.rejects(channel.request('record', { report }), { outcome: 'not_accepted' })
  channel.reaped()
  await tick()
  assert.equal(terminated, 8)
})

test('stream capacity rejection closes its unstarted list iterator so quiesce still drains', async t => {
  const { createDiagnosticsChildChannel } = await import('../src/diagnostics-ipc.mjs')
  const { createDiagnosticsDispatcher } = await import('../src/diagnostics-dispatcher.mjs')
  const root = await mkdtemp(join(tmpdir(), 'diagnostics-stream-capacity-'))
  class Endpoint extends EventEmitter {}
  const a = new Endpoint(), b = new Endpoint()
  for (const [local, peer] of [[a, b], [b, a]]) {
    local.connected = true
    local.send = (frame, callback) => queueMicrotask(() => { peer.emit('message', frame); callback?.() })
    local.disconnect = () => { if (local.connected) { local.connected = false; local.emit('disconnect') } }
  }
  const dispatcher = createDiagnosticsDispatcher({ root })
  const child = createDiagnosticsChildChannel({ dispatcher, event: b, versionId: null })
  const parent = createDiagnosticsParentChannel(a, { generation })
  t.after(async () => { parent.reaped(); child.close(); await rm(root, { recursive: true, force: true }) })
  await parent.control('initialize', { generation, mode: 'restore' })
  await parent.ready
  await parent.control('resume')
  await parent.request('record', { report })
  const requests = Array.from({ length: 5 }, () => parent.request('list', {}))
  const results = await Promise.allSettled(requests)
  await Promise.allSettled(requests.map(request => request.completion))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 4)
  assert.equal(results.filter(result => result.status === 'rejected').length, 1)
  assert.deepEqual(await parent.control('quiesce', {}, 60000), { quiesced: true })
})

test('IPC loss after stream metadata rejects caller but keeps completion until reaped', async t => {
  class Endpoint extends EventEmitter {
    connected = true
    sent = []
    send(frame, callback) { this.sent.push(frame); callback?.() }
    disconnect() { if (this.connected) { this.connected = false; this.emit('disconnect') } }
  }
  const endpoint = new Endpoint(), channel = createDiagnosticsParentChannel(endpoint, { generation })
  t.after(() => channel.reaped())
  const reading = channel.request('list', {})
  const id = endpoint.sent[0].id
  endpoint.emit('message', { type: 'accepted', kind: 'root', id })
  endpoint.emit('message', { type: 'result', kind: 'root', id, ok: true, value: { streamed: true } })
  let terminated = false
  void reading.completion.then(() => { terminated = true }, () => { terminated = true })
  endpoint.disconnect()
  await assert.rejects(reading, { code: 'DIAGNOSTICS_IPC_DISCONNECTED' })
  await tick()
  assert.equal(terminated, false)
  channel.reaped()
  await tick()
  assert.equal(terminated, true)
})
