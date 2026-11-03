import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { diagnosticRequestContext } from '../src/diagnostic-request-context.mjs'
import { diagnosticReportContext } from '../src/diagnostic-report-context.mjs'
import { Diagnostics } from '../src/diagnostics.mjs'

const fields = log => Object.fromEntries(log.split('\n').map(line => line.split(/=(.*)/su).slice(0, 2)))

test('three GET routes use fixed path types and preserve confirmed operation/expectation', () => {
  for (const [path, route, operation, expected] of [
    ['/api/schedules', '/api/schedules', 'schedule_read', 'schedule_data_response'],
    ['/api/message-images/private-owner/private-image.webp', '/api/message-images/:id/:id', 'unknown', 'successful_response'],
    ['/api/harness-auth/antigravity', '/api/harness-auth/:id', 'unknown', 'successful_response'],
  ]) {
    const log = diagnosticRequestContext({ method: 'GET', url: `${path}?secret=PRIVATE_QUERY#PRIVATE_FRAGMENT` })
    const context = fields(log)
    assert.equal(context.request_route, route)
    assert.equal(context.operation, operation)
    assert.equal(context.expected_result, expected)
    assert.equal(context.cause_status, 'unconfirmed')
    assert.equal(context.delivery_outcome, 'unknown')
    assert.doesNotMatch(log, /private-owner|private-image|antigravity|PRIVATE_QUERY|PRIVATE_FRAGMENT/u)
  }
})

test('secret/auth actions and paths not accepted by the real handlers remain other', () => {
  for (const [method, url] of [
    ['GET', '/api/harness-auth/codex/input'], ['POST', '/api/harness-auth/codex/input'],
    ['GET', '/api/secret-requests/private-id'], ['POST', '/api/schedules'],
    ['GET', '/api/message-images/private-owner/private-image.svg'],
    ['GET', '/api/message-images/private-owner/private-image.webp/extra'],
    ['GET', '/api/harness-auth/private-id'], ['HEAD', '/api/message-images/owner/image.png'],
  ]) {
    const context = fields(diagnosticRequestContext({ method, url }))
    assert.equal(context.request_route, '/api/other')
    assert.equal(context.operation, 'unknown')
    assert.equal(context.expected_result, 'unknown')
  }
})

test('the known schedule operation reaches existing aggregation without migrating old unknown; image/auth operations stay unknown', async t => {
  const root = await mkdtemp(join(tmpdir(), 'diagnostic-route-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const diagnostics = new Diagnostics(join(root, 'diagnostics.json'))
  await diagnostics.initialize()
  const legacy = await diagnostics.record({ code: 'SERVER_HTTP_500', module: 'server', diagnostic_log: 'scope=server_request\noperation=unknown\nactual_result=http_500_response_selected' })
  await diagnostics.setStatus(legacy.fingerprint, 'resolved')
  const old = structuredClone(diagnostics.rows.get(legacy.fingerprint))
  const log = diagnosticRequestContext({ method: 'GET', url: '/api/schedules' })
  const row = await diagnostics.record({ code: 'SERVER_HTTP_500', module: 'server', diagnostic_log: log })
  assert.equal(row.module, 'server')
  assert.equal(row.report_context.operation, 'schedule_read')
  assert.notEqual(row.fingerprint, legacy.fingerprint)
  assert.deepEqual(diagnostics.rows.get(legacy.fingerprint), old)
  for (const url of ['/api/message-images/owner/image.png', '/api/harness-auth/codex'])
    assert.equal(diagnosticReportContext(diagnosticRequestContext({ method: 'GET', url })), null)
})
