import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import { AitermClient } from '../src/aiterm-client.mjs'
import { BotAdministration } from '../src/bot-administration.mjs'
import { Diagnostics } from '../src/diagnostics.mjs'
import { executionFailureReport } from '../src/execution-failure-report.mjs'

const receipt = { schema: 'aiterm.agent-configure-error.v1', session_id: 'bot-synthetic', outcome: 'outcome_unknown', effect: 'possible' }
const returned = structuredContent => ({ isError: true, content: [{ type: 'text', text: 'synthetic-secret' }], structuredContent })
const timeout = Object.freeze(new McpError(ErrorCode.RequestTimeout, 'synthetic-secret'))
const cases = [
  ['RPC timeout', async () => { throw timeout }, 'call', false, false, 'MCP_REQUEST_TIMEOUT'],
  ['connect failure', async () => { throw Object.assign(Error('synthetic-secret'), { code: 'ECONNREFUSED' }) }, 'connect', false, false, 'ECONNREFUSED'],
  ['typed returned', async () => returned(receipt), null, true, true, 'unknown'],
  ['untyped returned', async () => returned(undefined), null, true, false, 'unknown'],
  ['wrong session returned', async () => returned({ ...receipt, session_id: 'other' }), null, true, false, 'unknown'],
]
for (const [name, call, phase, response, typed, code] of cases) test(`configuration provenance: ${name}`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'config-provenance-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'diagnostics.json'), diagnostics = new Diagnostics(path)
  await diagnostics.initialize()
  const client = new AitermClient({ env: {} })
  let calls = 0, original
  if (phase === 'connect') client.connect = call
  else client.client = { callTool: call }
  const bot = { id: 'bot-synthetic', model: 'old', reasoningEffort: 'high' }
  const bots = new Map([[bot.id, bot]])
  bots.previewUpdate = async (id, changes) => ({ ...bots.get(id), ...changes })
  bots.update = async (id, changes) => { const next = { ...bots.get(id), ...changes }; bots.set(id, next); return next }
  const logs = []
  const admin = new BotAdministration({ bots, writeLog: line => logs.push(line), reportError: report => diagnostics.record(report),
    transport: { async isRunning() { return true }, async reconfigure() {
      calls++
      try { await client.call('agent_configure', { session_id: bot.id, model: 'next' }) }
      catch (error) { original = error; throw error }
    } } })
  await admin.update(bot.id, { model: 'next' })
  await new Promise(resolve => setImmediate(resolve)); await diagnostics.pending
  const [row] = JSON.parse(await readFile(path, 'utf8')), detail = JSON.parse(row.diagnostic_log)
  assert.equal(detail.failure.error_code, code)
  assert.equal(detail.responseReturned, response ? true : undefined)
  assert.deepEqual(detail.configureFailure, typed ? { outcome: 'outcome_unknown', effect: 'possible' } : undefined)
  assert.deepEqual(detail.mcp_request, phase ? { phase, tool: 'agent_configure', ...(phase === 'call' ? { outcome: 'unknown' } : {}) } : undefined)
  if (phase === 'call') assert.equal(original, timeout)
  assert.equal(calls, 1)
  assert.equal(bots.get(bot.id).model, 'next')
  assert.equal(admin.view(bots.get(bot.id)).configurationApplication.state, 'failed')
  assert.equal(admin.view(bots.get(bot.id)).configurationApplication.outcome, 'outcome_unknown')
  assert.equal(row.severity, 'high'); assert.equal(row.status, 'open')
  assert.equal(row.fingerprint, 'b5159a7976e0c5597ce53d6d12c387075b9699da00d27ea5086b6206e0d4f267')
  assert.doesNotMatch(JSON.stringify([row, logs]), /synthetic-secret|session_id|next/)
})

test('configuration provenance rejects unsafe supplemental fields without changing wait diagnostics', () => {
  const error = Object.assign(Error('synthetic-secret'), { code: 'synthetic-secret',
    mcp_request: { phase: 'call', tool: 'agent_configure', outcome: 'unknown', secret: 'synthetic-secret' },
    agentConfigureResult: { ...receipt, extra: 'synthetic-secret' }, aitermResponseReturned: 'synthetic-secret' })
  const report = executionFailureReport('bot-synthetic', 'configuration', error)
  const detail = JSON.parse(report.diagnostic_log)
  assert.deepEqual(detail.failure, { error_type: 'Error', error_code: 'unknown', cause_code: 'unknown' })
  assert.equal(detail.mcp_request, undefined); assert.equal(detail.configureFailure, undefined)
  assert.equal(detail.responseReturned, undefined)
  assert.doesNotMatch(report.diagnostic_log, /synthetic-secret/)
  const wait = JSON.parse(executionFailureReport('bot-synthetic', 'seat_watch', error).diagnostic_log)
  assert.deepEqual(wait, { schema: 'bellteam.execution-failure.v1', botId: 'bot-synthetic', phase: 'seat_watch' })
})
