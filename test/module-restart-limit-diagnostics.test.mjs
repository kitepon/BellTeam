import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Diagnostics, createDiagnosticsAdminServer, moduleRestartLimitProblems } from '../src/diagnostics.mjs'
import { createDiagnosticsDispatcher } from '../src/diagnostics-dispatcher.mjs'
import { createDiagnosticsFacade } from '../src/diagnostics-facade.mjs'
import { createDiagnosticsParentChannel } from '../src/diagnostics-ipc.mjs'
import { validateDiagnosticsRequest, validateDiagnosticsRow } from '../src/diagnostics-protocol.mjs'
import { waitNotificationsChildClose } from '../src/notifications-ipc.mjs'

const generation = 'restart-limit:fixture'
const active = (moduleId = 'conversation') => ({ kind: 'module_restart_limit', moduleId, count: 5,
  windowSeconds: 1800, lastExit: { code: null, signal: 'SIGABRT' }, lastReason: 'process_exit' })
const clear = (moduleId = 'conversation') => ({ kind: 'module_restart_limit', moduleId, cleared: true })
const collect = async stream => { const rows = []; for await (const row of stream) rows.push(row); return rows }
const temporary = async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-restart-limit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('restart-limit intake accepts exact runtime DTOs and rejects private or malformed fields', () => {
  const validate = problem => validateDiagnosticsRequest('recordModuleRestartLimit', { problem }, { generation })
  for (const moduleId of ['web-gateway', 'notifications', 'members', 'memory', 'usage', 'diagnostics', 'conversation', 'execution']) {
    validate(active(moduleId)); validate(clear(moduleId))
  }
  validate({ ...active(), lastExit: { code: 1, signal: null } })
  validate({ ...active(), lastExit: { code: null, signal: null }, lastReason: 'recovery_failed' })
  for (const patch of [
    { kind: 'other' }, { moduleId: 'private-path' }, { count: 4 }, { count: 5.5 }, { count: Infinity },
    { count: Number.MAX_SAFE_INTEGER + 1 }, { windowSeconds: 60 }, { lastReason: 'private-error-body' },
    { lastExit: { code: 2 ** 31, signal: null } }, { lastExit: { code: 1 } },
    { lastExit: { code: null, signal: 'private-signal' } }, { lastExit: { code: null, signal: null, stderr: 'secret' } },
    { secret: 'private-input' }, { cleared: true },
  ]) assert.throws(() => validate({ ...active(), ...patch }), /DIAGNOSTIC_INVALID/)
  assert.throws(() => validate({ ...clear(), cleared: false }), /DIAGNOSTIC_INVALID/)
  assert.throws(() => validate({ ...clear(), count: 5 }), /DIAGNOSTIC_INVALID/)
  assert.throws(() => validate(Object.assign(Object.create({ private: true }), active())), /DIAGNOSTIC_INVALID/)
})

test('facade and real IPC retain per-module problems, explicit recovery and safe GET projection', { timeout: 15000 }, async t => {
  const root = await temporary(t)
  const child = spawn(process.execPath, [new URL('./fixtures/diagnostics-runtime-child.mjs', import.meta.url).pathname, root], {
    env: {}, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced',
  })
  const ended = waitNotificationsChildClose(child)
  const channel = createDiagnosticsParentChannel(child, { generation })
  t.after(async () => { child.kill('SIGKILL'); await ended; channel.reaped() })
  await channel.control('initialize', { generation, mode: 'restore' })
  await channel.ready
  await channel.control('resume')
  const facade = createDiagnosticsFacade({ request: channel.request })
  assert.equal(await facade.recordModuleRestartLimit(clear()), null)
  const first = await facade.recordModuleRestartLimit(active())
  assert.equal(validateDiagnosticsRow(first), true)
  const path = join(root, 'logs/diagnostics.json')
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), [first])
  await facade.setNote(first.fingerprint, 'Synthetic private investigation')
  const duplicate = await facade.recordModuleRestartLimit({ ...active(), count: 6 })
  assert.equal(duplicate.fingerprint, first.fingerprint)
  assert.equal(duplicate.occurrence_count, 1)
  assert.equal(duplicate.investigation_note.summary, 'Synthetic private investigation')
  const memory = { ...active('memory'), lastExit: { code: null, signal: null }, lastReason: 'recovery_failed' }
  await facade.recordModuleRestartLimit(memory)
  assert.equal((await facade.list()).length, 2)
  const resolved = await facade.recordModuleRestartLimit(clear())
  assert.equal(resolved.status, 'resolved')
  assert.deepEqual(resolved.problem, duplicate.problem)
  assert.deepEqual(await facade.recordModuleRestartLimit(clear()), resolved)
  const reopened = await facade.recordModuleRestartLimit({ ...active(), lastReason: 'ready_timeout' })
  assert.equal(reopened.occurrence_count, 2)
  assert.equal(reopened.status, 'open')
  await facade.recordModuleRestartLimit(clear())
  await channel.control('quiesce')
  await channel.control('exit')
  assert.deepEqual(await ended, { code: 0, signal: null })
  const restored = new Diagnostics(path)
  await restored.initialize({ mode: 'restore' })
  assert.deepEqual(restored.list('open').map(row => row.problem), [memory])
  const server = createDiagnosticsAdminServer({ diagnostics: restored, key: 'fixture-key' })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/api/admin/logs`
  assert.equal((await fetch(url)).status, 401)
  const response = await fetch(url, { headers: { authorization: 'Bearer fixture-key' } })
  assert.equal(response.status, 200)
  const rows = await response.json()
  const projected = moduleRestartLimitProblems(rows)
  assert.equal(projected.length, 2)
  assert.deepEqual(projected.find(row => row.moduleId === 'memory'), {
    fingerprint: rows.find(row => row.problem.moduleId === 'memory').fingerprint, status: 'open', ...memory,
  })
  assert.equal(projected.find(row => row.moduleId === 'conversation').status, 'resolved')
  assert.equal(JSON.stringify(projected).includes('Synthetic private investigation'), false)
  assert.ok(projected.every(row => !Object.hasOwn(row, 'investigation_note') && !Object.hasOwn(row, 'diagnostic_log')))
  assert.deepEqual(moduleRestartLimitProblems([{ category: 'SERVER_HTTP_503', diagnostic_log: 'private' }]), [])
  assert.throws(() => moduleRestartLimitProblems([{ ...first, problem: { ...active(), secret: 'private' } }]), /DIAGNOSTIC_INVALID/)
  assert.throws(() => validateDiagnosticsRow({ ...first, problem: clear() }), /DIAGNOSTICS_RESULT_INVALID/)
})

test('new intake waits for save/drain ACK and rolls back only its failed mutation', async t => {
  const root = await temporary(t), dispatcher = createDiagnosticsDispatcher({ root }), context = { generation }
  await dispatcher.control('initialize', { generation, mode: 'restore' })
  await dispatcher.control('resume', {})
  const originalSave = Diagnostics.prototype.save
  let release, entered
  const gate = new Promise(resolve => { release = resolve }), started = new Promise(resolve => { entered = resolve })
  Diagnostics.prototype.save = async function () { entered(); await gate; return originalSave.call(this) }
  try {
    let acknowledged = false, drained = false
    const write = dispatcher.dispatch('recordModuleRestartLimit', { problem: active() }, context).then(row => { acknowledged = true; return row })
    await started
    const drain = dispatcher.control('quiesce', {}).then(value => { drained = true; return value })
    await new Promise(setImmediate)
    assert.equal(acknowledged, false)
    assert.equal(drained, false)
    release()
    await write; await drain
  } finally { release(); Diagnostics.prototype.save = originalSave }
  await dispatcher.control('resume', {})
  const before = await collect(dispatcher.dispatch('list', {}, context))
  Diagnostics.prototype.save = async () => { throw new Error('synthetic-save-failure') }
  try {
    await assert.rejects(dispatcher.dispatch('recordModuleRestartLimit', { problem: clear() }, context), /synthetic-save-failure/)
    await assert.rejects(dispatcher.dispatch('recordModuleRestartLimit', { problem: active('memory') }, context), /synthetic-save-failure/)
  } finally { Diagnostics.prototype.save = originalSave }
  assert.deepEqual(await collect(dispatcher.dispatch('list', {}, context)), before)
  assert.deepEqual(JSON.parse(await readFile(join(root, 'logs/diagnostics.json'), 'utf8')), before)
  assert.equal((await dispatcher.dispatch('recordModuleRestartLimit', { problem: clear() }, context)).status, 'resolved')
  await dispatcher.disconnect()
})
