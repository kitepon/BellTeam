import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'

test('partial stop retains root acceptance and descendant refusal without exposing raw details or retrying', async t => {
  const bot = { id: 'bot-a', session: 'bot-a' }, logs = []
  let calls = 0
  const transport = new AitermTransport({ executionBridge: {}, requestStop: async () => {
    calls++
    return { status: 'partial', targets: [
      { session_id: bot.id, status: 'sent' },
      { session_id: 'secret-child-name', status: 'failed', error: 'EXECUTION_STALE_GENERATION' },
      { session_id: 'other-secret', status: 'failed', error: 'SECRET_EXCEPTION_TEXT' },
    ], message: 'secret payload' }
  } })
  const server = createBellTeamServer({ bots: new Map([[bot.id, bot]]), transport,
    authorize: async () => true, writeLog: line => logs.push(line) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bots/bot-a/stop`, { method: 'POST' })
  assert.equal(response.status, 502)
  assert.equal((await response.json()).error, 'BOT_STOP_UNCONFIRMED')
  assert.equal(calls, 1)
  const report = JSON.parse(logs.find(line => line.startsWith('BellTeam stop failure: ')).slice('BellTeam stop failure: '.length))
  assert.equal(report.botNamedTargetStatus, 'sent')
  assert.equal(report.rpcResultReturned, true)
  assert.equal(report.stopEffect, 'unconfirmed')
  assert.deepEqual(report.targetCounts, { sent: 1, idle: 0, failed: 2 })
  assert.deepEqual(report.failureCodes, ['EXECUTION_STALE_GENERATION'])
  assert.doesNotMatch(JSON.stringify(report), /secret|SECRET_EXCEPTION_TEXT/u)
})

test('a returned typed refusal is recorded without exception text or changing failed stop outcome', async t => {
  const logs = []
  const executionError = { schema: 'aiterm.execution-error.v1', code: 'EXECUTION_BUSY', effect: 'not_started', follow_up: 'status_only' }
  let calls = 0
  const server = createBellTeamServer({ bots: new Map([['bot-a', { id: 'bot-a' }]]), authorize: async () => true,
    transport: { async interrupt() { calls++; throw Object.assign(new Error('secret raw error'), { executionError, aitermResponseReturned: true }) } },
    writeLog: line => logs.push(line) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bots/bot-a/stop`, { method: 'POST' })
  assert.equal(response.status, 502); assert.equal(calls, 1)
  const report = JSON.parse(logs.find(line => line.startsWith('BellTeam stop failure: ')).slice('BellTeam stop failure: '.length))
  assert.equal(report.executionCode, 'EXECUTION_BUSY')
  assert.equal(report.executionEffect, 'not_started')
  assert.equal(report.rpcResultReturned, true)
  assert.equal(report.stopEffect, 'unconfirmed')
  assert.doesNotMatch(JSON.stringify(report), /secret/u)
})
