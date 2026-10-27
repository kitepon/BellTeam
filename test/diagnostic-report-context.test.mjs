import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { Diagnostics } from '../src/diagnostics.mjs'
import { diagnosticFailureDetails, diagnosticReportContext } from '../src/diagnostic-report-context.mjs'
import { diagnosticRequestContext } from '../src/diagnostic-request-context.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'

const log = (operation, actual = 'network_timeout', extra = '') =>
  `scope=app_request\noperation=${operation}\nactual_result=${actual}${extra}`

test('SDKの要求時間切れ符号をHTTP診断に保持し、未知RPC番号や本文は含めない', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-mcp-timeout-code-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const diagnostics = new Diagnostics(join(root, 'diagnostics.json'))
  await diagnostics.initialize()
  const legacy = await diagnostics.record({ code: 'SERVER_HTTP_500', module: 'server', diagnostic_log: 'McpError\nerror_code=unknown' })
  const original = structuredClone(legacy)
  const error = new McpError(ErrorCode.RequestTimeout, 'synthetic-private-message')
  const server = createBellTeamServer({ authorize: () => true, diagnostics, bots: { async refresh() { throw error } } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bots`)
  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), { error: 'INTERNAL_ERROR' })
  const row = diagnostics.list().find(value => value.fingerprint !== legacy.fingerprint)
  assert.equal(row.report_context.error_code, 'MCP_REQUEST_TIMEOUT')
  assert.match(row.diagnostic_log, /^error_code=MCP_REQUEST_TIMEOUT$/mu)
  assert.doesNotMatch(JSON.stringify(row), /synthetic-private-message/u)
  assert.equal(diagnosticFailureDetails(new Error('wrapper', { cause: error })).cause_code, 'MCP_REQUEST_TIMEOUT')
  assert.equal(diagnosticFailureDetails(new McpError(-32999, 'private-code')).error_code, 'unknown')
  assert.equal(diagnosticFailureDetails(Object.assign(new Error(), { code: ErrorCode.RequestTimeout })).error_code, 'unknown')
  assert.deepEqual(diagnostics.list().find(value => value.fingerprint === legacy.fingerprint), original)
})

test('会話のGET/POSTとHTTP結果を分け、旧集約と保存原文を変更しない', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-report-groups-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'diagnostics.json'), d = new Diagnostics(file)
  await d.initialize()
  const report = { code: 'IOS_HTTP_5XX', module: 'conversation', severity: 'warn' }
  const legacy = await d.record({ ...report, diagnostic_log: 'old insufficient report' })
  await d.setStatus(legacy.fingerprint, 'resolved')
  const legacyBefore = structuredClone(d.list().find(x => x.fingerprint === legacy.fingerprint))
  const get = await d.record({ ...report, diagnostic_log: log('conversation_read', 'http_502') })
  const post = await d.record({ ...report, diagnostic_log: log('message_send', 'http_500') })
  const post502 = await d.record({ ...report, diagnostic_log: log('message_send', 'http_502') })
  assert.equal(new Set([legacy.fingerprint, get.fingerprint, post.fingerprint, post502.fingerprint]).size, 4)
  const again = await d.record({ ...report, app_version: '1.0.1(53)', diagnostic_log: log('message_send', 'http_500') })
  assert.equal(again.fingerprint, post.fingerprint)
  assert.equal(again.occurrence_count, 2)
  assert.equal(again.report_context.operation, 'message_send')
  assert.match(again.message_template, /メッセージ送信.*HTTP500.*原因=未特定/u)
  assert.deepEqual(d.list().find(x => x.fingerprint === legacy.fingerprint), legacyBefore)
  const reloaded = new Diagnostics(file)
  await reloaded.initialize()
  assert.deepEqual(reloaded.list(), d.list())
  assert.equal(get.diagnostic_log, log('conversation_read', 'http_502'))
  assert.equal(JSON.parse(await readFile(file, 'utf8')).length, 4)
})

test('閉じた新しい報告にも独立した再発は記録し開き直す', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-report-reopen-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const d = new Diagnostics(join(root, 'diagnostics.json'))
  await d.initialize()
  const report = { code: 'IOS_NETWORK_TIMEOUT', module: 'conversation', severity: 'warn', diagnostic_log: log('conversation_read') }
  const first = await d.record(report)
  await d.setStatus(first.fingerprint, 'resolved')
  const second = await d.record(report)
  assert.equal(second.fingerprint, first.fingerprint)
  assert.equal(second.status, 'open')
  assert.equal(second.occurrence_count, 2)
})

test('未知/重複/要求traceの無い文脈から操作や原因を作らない', () => {
  for (const value of [undefined, '', log('unknown'), log('message_send', 'synthetic-secret'),
    log('message_send') + '\noperation=conversation_read',
    log('message_send').replace('app_request', 'app_operation')]) assert.equal(diagnosticReportContext(value), null)
  const context = diagnosticReportContext(log('message_send', 'http_500', '\ncause_code=synthetic-secret\nerror_type=private-type\nfailure_stage=private-stage'))
  assert.equal(context.context.cause_code, 'unknown')
  assert.doesNotMatch(JSON.stringify(context), /synthetic-secret|private-type|private-stage/u)
})

test('HTTP500で観測済みの固定cause符号と例外段を保存し、任意本文は加えない', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-report-cause-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const d = new Diagnostics(join(root, 'diagnostics.json'))
  await d.initialize()
  const error = new TypeError('synthetic-private-message', { cause: { code: 'UND_ERR_SOCKET', message: 'synthetic-private-cause' } })
  error.stack = 'TypeError: synthetic-private-message\n    at async AitermClient.call (<app>/src/aiterm-transport.mjs:99:1)'
  const server = createBellTeamServer({ authorize: () => true, diagnostics: d, bots: { async refresh() { throw error } } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/bots?token=synthetic-query`)).status, 500)
  const row = d.list()[0]
  assert.equal(row.report_context.cause_code, 'UND_ERR_SOCKET')
  assert.equal(row.report_context.failure_stage, 'mcp_call')
  assert.match(row.diagnostic_log, /^cause_status=unconfirmed$/mu)
  assert.doesNotMatch(JSON.stringify(row), /synthetic-private|synthetic-query/u)
  const second = await d.record({ code: 'SERVER_HTTP_500', module: 'server', diagnostic_log:
    diagnosticRequestContext({ method: 'GET', url: '/api/bots' }, [], new TypeError('synthetic-private', { cause: { code: 'ECONNREFUSED' } })) })
  assert.notEqual(second.fingerprint, row.fingerprint)
  assert.deepEqual(diagnosticFailureDetails({ constructor: { name: 'private-class' }, code: 'private-code', cause: { code: 'private-cause' } }),
    { error_type: 'unknown', error_code: 'unknown', cause_code: 'unknown' })
})
