import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Diagnostics, createDiagnosticsAdminServer } from '../src/diagnostics.mjs'
import { createDiagnosticsDispatcher, DIAGNOSTICS_STATE_COMPATIBILITY } from '../src/diagnostics-dispatcher.mjs'

const context = { generation: 'builtin:fixture' }
const report = { code: 'SERVER_HTTP_503', module: 'server', diagnostic_log: 'code=unknown' }
const collect = async stream => { const rows = []; for await (const row of stream) rows.push(row); return rows }
const tick = () => new Promise(setImmediate)
const temporary = async t => {
  const root = await mkdtemp(join(tmpdir(), 'diagnostics-module-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
const start = async (root, options = {}) => {
  const dispatcher = createDiagnosticsDispatcher({ root, ...options })
  assert.deepEqual(await dispatcher.control('initialize', { ...context, mode: 'restore' }), { stateCompatibility: DIAGNOSTICS_STATE_COMPATIBILITY })
  await dispatcher.control('resume', {})
  return dispatcher
}

test('closed methods/DTO/generation and lifecycle preserve existing saved row', async t => {
  const root = await temporary(t), d = createDiagnosticsDispatcher({ root })
  assert.throws(() => d.dispatch('record', { report }, context), /UNAVAILABLE/u)
  await d.control('initialize', { ...context, mode: 'bootstrap' })
  assert.throws(() => d.validateRequest('record', { report }, context), /NOT_ACCEPTED/u)
  await d.control('resume', {})
  for (const [method, params, ctx] of [
    ['save', {}, context], ['record', { report, file: '/other' }, context],
    ['record', { report: { ...report, secret: 'private' } }, context],
    ['record', { report: { ...report, code: 'UNKNOWN' } }, context],
    ['list', { limit: 1001 }, context], ['list', {}, { ...context, id: 1 }],
    ['list', {}, { generation: 'stale' }], ['list', {}, { generation: 'bad value' }],
    ['setNote', { fingerprint: 'a'.repeat(64), note: '' }, context],
  ]) assert.throws(() => d.validateRequest(method, params, ctx))
  const row = await d.dispatch('record', { report }, context)
  assert.equal(row.category, 'SERVER_HTTP_503')
  assert.equal(row.occurrence_count, 1)
  assert.equal(row.severity, 'warn')
  assert.deepEqual(JSON.parse(await readFile(join(root, 'logs/diagnostics.json'), 'utf8')), [row])
  const noted = await d.dispatch('setNote', { fingerprint: row.fingerprint, note: '根拠' }, context)
  assert.equal(noted.investigation_note.summary, '根拠')
  assert.equal((await d.dispatch('setStatus', { fingerprint: row.fingerprint, status: 'resolved' }, context)).status, 'resolved')
  assert.equal((await d.dispatch('updateInvestigation', { fingerprint: row.fingerprint, status: 'open' }, context)).status, 'open')
  assert.deepEqual(await d.control('quiesce', {}), { quiesced: true })
  assert.throws(() => d.validateRequest('record', { report }, context), /NOT_ACCEPTED/u)
  assert.deepEqual(await d.control('exit', {}), { closed: true })
  const restored = await start(root)
  const [listed] = await collect(restored.dispatch('list', {}, context))
  assert.equal(listed.fingerprint, row.fingerprint)
  assert.equal(listed.diagnostic_context.investigation_note.summary, '根拠')
  await restored.disconnect()
})

test('quiesce waits for save ACK, resume invalidates pending quiesce, failure is not success', async t => {
  const root = await temporary(t), d = await start(root)
  const original = Diagnostics.prototype.save
  let release, entered
  const gate = new Promise(resolve => { release = resolve }), started = new Promise(resolve => { entered = resolve })
  Diagnostics.prototype.save = async function () { entered(); await gate; return original.call(this) }
  try {
    let acknowledged = false, drained = false
    const write = d.dispatch('record', { report }, context).then(row => { acknowledged = true; return row })
    await started
    const quiesce = d.control('quiesce', {}).then(result => { drained = true; return result })
    await tick()
    assert.equal(acknowledged, false)
    assert.equal(drained, false)
    await assert.rejects(d.control('exit', {}), /NOT_QUIESCED/u)
    assert.deepEqual(await d.control('resume', {}), { resumed: true })
    release()
    await write
    assert.deepEqual(await quiesce, { quiesced: false })
  } finally { release(); Diagnostics.prototype.save = original }
  const before = await readFile(join(root, 'logs/diagnostics.json'), 'utf8')
  Diagnostics.prototype.save = async () => { throw Object.assign(new Error('synthetic-save-failure'), { code: 'EIO' }) }
  try { await assert.rejects(d.dispatch('record', { report }, context), /synthetic-save-failure/u) }
  finally { Diagnostics.prototype.save = original }
  assert.equal(await readFile(join(root, 'logs/diagnostics.json'), 'utf8'), before)
  assert.deepEqual(await d.control('quiesce', {}), { quiesced: true })
  assert.deepEqual(await d.control('exit', {}), { closed: true })
})

test('accepted request dispatched after quiesce remains live until saved', async t => {
  const root = await temporary(t), d = await start(root)
  d.validateRequest('record', { report }, context)
  assert.deepEqual(await d.control('quiesce', {}), { quiesced: true })
  const write = d.dispatch('record', { report }, context)
  await assert.rejects(d.control('exit', {}), /NOT_QUIESCED/u)
  assert.equal((await write).occurrence_count, 1)
  assert.deepEqual(await d.control('quiesce', {}), { quiesced: true })
  await d.control('exit', {})
})

test('restore reads same file and optional notes without chmod, mtime or bytes changes', async t => {
  const root = await temporary(t), file = join(root, 'logs/diagnostics.json'), notes = join(root, 'notes.json')
  const seed = new Diagnostics(file)
  const row = await seed.record(report)
  const note = { summary: '調査根拠', evidence: ['fixture/one'], updated_at: '2026-11-03T00:00:00Z' }
  await writeFile(notes, JSON.stringify({ [row.fingerprint]: note }))
  await chmod(file, 0o640)
  const before = await stat(file), raw = await readFile(file, 'utf8'), notesBefore = await stat(notes)
  const d = createDiagnosticsDispatcher({ root, investigationsFile: notes })
  await d.control('initialize', { ...context, mode: 'restore' })
  assert.throws(() => d.validateRequest('record', { report }, context), /NOT_ACCEPTED/u)
  await d.control('resume', {})
  const [listed] = await collect(d.dispatch('list', {}, context))
  assert.deepEqual(listed.investigation, note)
  assert.equal((await stat(file)).mode, before.mode)
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs)
  assert.equal((await stat(notes)).mtimeMs, notesBefore.mtimeMs)
  assert.equal(await readFile(file, 'utf8'), raw)
  await d.disconnect()
  const empty = join(root, 'uncreated')
  const fresh = await start(empty)
  await fresh.disconnect()
  await assert.rejects(stat(empty), { code: 'ENOENT' })
})

test('large list retains one snapshot and drains until consumption; disconnect closes unstarted iterator', async t => {
  const root = await temporary(t), file = join(root, 'logs/diagnostics.json')
  await mkdir(join(root, 'logs'))
  const rows = Array.from({ length: 400 }, (_, i) => ({
    fingerprint: createHash('sha256').update(String(i)).digest('hex'), severity: 'warn',
    message_template: 'fixture', category: report.code, module: 'server', occurrence_count: 1,
    last_seen: new Date(i).toISOString(), status: 'open', diagnostic_log: 'x'.repeat(49152),
  }))
  await writeFile(file, JSON.stringify(rows))
  const d = await start(root), stream = d.dispatch('list', { limit: 1000 }, context)
  await d.dispatch('setStatus', { fingerprint: rows[0].fingerprint, status: 'resolved', note: '後日判定' }, context)
  let drained = false
  const quiesce = d.control('quiesce', {}).then(value => { drained = true; return value })
  await tick()
  assert.equal(drained, false)
  let count = 0, bytes = 2, last = ''
  for await (const row of stream) {
    assert.equal(row.status, 'open')
    assert.equal(row.investigation_note, undefined)
    assert.equal(row.diagnostic_log.length, 49152)
    assert.ok(!last || last >= row.last_seen)
    last = row.last_seen
    bytes += Buffer.byteLength(JSON.stringify(row)) + 1
    count++
  }
  assert.equal(count, 400)
  assert.ok(bytes > 16 * 1024 * 1024)
  assert.deepEqual(await quiesce, { quiesced: true })
  await d.control('resume', {})
  d.dispatch('list', {}, context)
  await d.disconnect()
  const other = await start(join(root, 'other'))
  assert.deepEqual(await collect(other.dispatch('list', {}, context)), [])
  await other.disconnect()
})

test('management GET keeps array contract with async facade', async t => {
  const root = await temporary(t), d = await start(root)
  const row = await d.dispatch('record', { report }, context)
  const server = createDiagnosticsAdminServer({ diagnostics: {
    list: (status, limit) => collect(d.dispatch('list', { status, limit }, context)),
  }, key: 'fixture-secret' })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/logs`, { headers: { authorization: 'Bearer fixture-secret' } })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), [row])
  } finally { await new Promise(resolve => server.close(resolve)); await d.disconnect() }
})
