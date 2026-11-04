import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Diagnostics, createDiagnosticsAdminServer, moduleChildExitReport, validateModuleChildExitDiagnostic } from '../src/diagnostics.mjs'
import { validateDiagnosticsRequest } from '../src/diagnostics-protocol.mjs'

const observation = (component = 'conversation') => ({
  schema: 'bellteam.module-child-exit.v1', component, exitCode: null, signal: 'SIGABRT',
  stderrCodes: [], reason: 'heap_out_of_memory', stderrBytes: 65536, stderrTruncated: true,
  stderrTail: [{ kind: 'gc', beforeMiB: 1024.5, afterMiB: 1020, capacityMiB: 1040, pauseMs: 29.5 }, { kind: 'heap_oom' }],
})

test('closed child-exit boundary rejects private text, malformed values and unbounded evidence', () => {
  assert.equal(validateModuleChildExitDiagnostic(observation()), true)
  for (const patch of [
    { stderr: 'synthetic-private-secret' }, { component: 'private-path' }, { signal: 'private-signal' },
    { exitCode: 2 ** 32 }, { stderrBytes: Number.MAX_SAFE_INTEGER + 1 }, { stderrCodes: ['ERR_PRIVATE'] },
    { stderrCodes: ['ERR_MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'] }, { reason: 'OS_OOM_KILL' },
    { stderrTail: ['synthetic-private-secret'] }, { stderrTail: Array(9).fill({ kind: 'heap_oom' }) },
    { stderrTail: Array(1) },
    { stderrTail: [{ kind: 'gc', beforeMiB: Infinity, afterMiB: 0, capacityMiB: 1, pauseMs: 0 }] },
    { stderrTail: [{ kind: 'heap_oom', message: 'synthetic-private-secret' }] },
  ]) assert.throws(() => moduleChildExitReport({ ...observation(), ...patch }), /DIAGNOSTIC_INVALID/)
  const inherited = Object.assign(Object.create({ toJSON: () => ({ private: 'synthetic-private-secret' }) }), observation())
  assert.equal(validateModuleChildExitDiagnostic(inherited), false)
  assert.throws(() => moduleChildExitReport(inherited), /DIAGNOSTIC_INVALID/)
  for (const diagnostic_log of ['private', undefined, JSON.stringify({ ...observation(), stderr: 'synthetic-private-secret' }),
    ' '.repeat(4096) + JSON.stringify(observation())]) {
    assert.throws(() => validateDiagnosticsRequest('record', { report: {
      code: 'SERVER_MODULE_CHILD_EXITED', module: 'server', diagnostic_log,
    } }, { generation: 'fixture' }), /DIAGNOSTIC_INVALID/)
  }
})

test('child exit uses one writer, six component aggregates, restore and authenticated management GET', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-child-exit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'diagnostics.json'), writer = new Diagnostics(path)
  await writer.initialize()
  const report = moduleChildExitReport(observation())
  validateDiagnosticsRequest('record', { report }, { generation: 'fixture' })
  const first = await writer.record(report)
  assert.equal(JSON.parse(await readFile(path, 'utf8'))[0].diagnostic_log, report.diagnostic_log)
  await writer.setStatus(first.fingerprint, 'resolved')
  const latest = { ...observation(), reason: 'unknown', stderrTail: [], stderrCodes: [], signal: 'SIGKILL', stderrBytes: 0, stderrTruncated: false }
  const second = await writer.record(moduleChildExitReport(latest))
  assert.equal(second.fingerprint, first.fingerprint)
  assert.equal(second.occurrence_count, 2)
  assert.equal(second.status, 'open')
  assert.equal(JSON.parse(second.diagnostic_log).reason, 'unknown')
  for (const component of ['usage', 'diagnostics', 'members', 'notifications', 'web-gateway'])
    await writer.record(moduleChildExitReport(observation(component)))
  const restored = new Diagnostics(path)
  await restored.initialize({ mode: 'restore' })
  assert.equal(restored.list().length, 6)
  assert.equal(new Set(restored.list().map(row => row.fingerprint)).size, 6)
  const server = createDiagnosticsAdminServer({ diagnostics: restored, key: 'fixture-key' })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/api/admin/logs`
  assert.equal((await fetch(url)).status, 401)
  const response = await fetch(url, { headers: { authorization: 'Bearer fixture-key' } })
  assert.equal(response.status, 200)
  const rows = await response.json()
  assert.deepEqual(rows, restored.list())
  assert.ok(rows.every(row => row.category === 'SERVER_MODULE_CHILD_EXITED' && row.module === 'server' && row.severity === 'high'))
})
