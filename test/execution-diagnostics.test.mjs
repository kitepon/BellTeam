import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Diagnostics, createDiagnosticsAdminServer } from '../src/diagnostics.mjs'

test('モデル適用と追跡失敗を保存・再読込しBugHub管理GETへ渡す', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bt-execution-diagnostics-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'diagnostics.json')
  const diagnostics = new Diagnostics(file)
  await diagnostics.initialize()
  const reports = [
    { code: 'SERVER_MODEL_CONFIGURATION_FAILED', module: 'bots',
      diagnostic_log: JSON.stringify({ schema: 'bellteam.execution-failure.v1', botId: 'fixture-bot',
        stage: 'configure', outcome: 'not_applied', effect: 'not_started' }) },
    { code: 'SERVER_TURN_TRACKING_FAILED', module: 'queue',
      diagnostic_log: JSON.stringify({ schema: 'bellteam.execution-failure.v1', botId: 'fixture-bot',
        stage: 'wait', code: 'SEAT_PROCESS_FAILED', exitCode: 3 }) },
  ]
  for (const report of reports) await diagnostics.record(report)
  const reloaded = new Diagnostics(file)
  await reloaded.initialize()
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  const server = createDiagnosticsAdminServer({ diagnostics: reloaded, key: 'fixture-only-key' })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/api/admin/logs?status=open`
  assert.equal((await fetch(url)).status, 401)
  const response = await fetch(url, { headers: { authorization: 'Bearer fixture-only-key' } })
  assert.equal(response.status, 200)
  const rows = await response.json()
  assert.equal(rows.length, 2)
  for (const report of reports) {
    const row = rows.find(value => value.category === report.code)
    assert.equal(row.module, report.module)
    assert.equal(row.severity, 'high')
    assert.equal(row.status, 'open')
    assert.equal(row.diagnostic_log, report.diagnostic_log)
    assert.equal(row.diagnostic_log_version, 'server')
    assert.ok(Number.isFinite(Date.parse(row.diagnostic_log_received_at)))
  }
})
