import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { AitermClient } from '../src/aiterm-client.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'
import { diagnosticRequestContext } from '../src/diagnostic-request-context.mjs'
import { diagnosticReportContext } from '../src/diagnostic-report-context.mjs'

const codes = ['CLAUDE_AUTH_NOT_AUTHENTICATED', 'CLAUDE_AUTH_STATUS_UNCONFIRMED', 'CLAUDE_AUTH_STATUS_TIMEOUT']
const detail = code => ({ schema: 'aiterm.agent-launch-error.v1', harness: 'claude-code', code,
  phase: 'authentication_preflight', effect: 'not_issued', session_created: false })
function fixture(structuredContent) {
  const client = new AitermClient()
  let calls = 0
  client.client = { async callTool() { calls++; return { isError: true,
    content: [{ type: 'text', text: 'synthetic-private-message' }], structuredContent } } }
  return { client, calls: () => calls }
}

test('通常launchとaliasは型付き認証拒否だけを保存し一回で失敗を返す', async () => {
  for (const name of ['agent_launch', 'claude_agent']) for (const code of codes) {
    const f = fixture({ ...detail(code), message: 'synthetic-private-message', status_body: 'synthetic-private-status' })
    const error = await f.client.call(name).catch(e => e)
    assert.equal(error.code, code)
    assert.equal(error.aitermResponseReturned, true)
    assert.deepEqual(error.agentLaunchError, detail(code))
    assert.equal(f.calls(), 1)
  }
})

test('HTTP失敗の診断に起動前拒否の観測を残し、旧unknownと三分類を分ける', async t => {
  const rows = []
  let current = fixture(detail(codes[0]))
  const server = createBellTeamServer({ bots: new Map(), rooms: new Map(), store: {}, transport: {},
    messenger: { async sendmessage() { await current.client.call('agent_launch') } },
    diagnostics: { async record(row) { rows.push(row) } }, authorize: async () => true, writeLog() {} })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const keys = new Set()
  for (const code of codes) {
    current = fixture(detail(code))
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/deliveries/direct`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(response.status, 500)
    assert.equal((await response.json()).error, 'INTERNAL_ERROR')
    const log = rows.at(-1).diagnostic_log
    assert.match(log, new RegExp(`error_code=${code}\\n`))
    assert.match(log, /native_launch_phase=authentication_preflight/)
    assert.match(log, /native_launch_effect=not_issued/)
    assert.match(log, /native_session_created=false/)
    assert.equal(log.includes('synthetic-private'), false)
    keys.add(diagnosticReportContext(log).key)
    assert.equal(current.calls(), 1)
  }
  const baseline = diagnosticReportContext(diagnosticRequestContext({ method: 'POST', url: '/api/deliveries/direct' }, [], new Error()))
  assert.equal(keys.size, 3)
  assert.equal(keys.has(baseline.key), false)
})

test('文章や不完全なNative結果から認証原因や未発行を推測しない', async () => {
  for (const native of [undefined, { ...detail(codes[0]), code: 'private-code' },
    { ...detail(codes[0]), phase: 'private-phase' }, { ...detail(codes[0]), effect: 'unknown' },
    { ...detail(codes[0]), session_created: true }]) {
    const f = fixture(native), error = await f.client.call('agent_launch').catch(e => e)
    assert.equal(error.agentLaunchError, undefined)
    assert.equal(error.code, undefined)
    const log = diagnosticRequestContext({ method: 'POST', url: '/api/deliveries/direct' }, [], error)
    assert.equal(log.includes('native_launch_effect='), false)
    assert.equal(log.includes('private-'), false)
    assert.equal(f.calls(), 1)
  }
})
