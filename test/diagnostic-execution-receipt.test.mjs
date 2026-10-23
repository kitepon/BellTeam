import test from 'node:test'
import assert from 'node:assert/strict'
import { createBellTeamServer } from '../src/http-server.mjs'
import { diagnosticRequestContext } from '../src/diagnostic-request-context.mjs'
import { diagnosticReportContext } from '../src/diagnostic-report-context.mjs'

const request = { method: 'POST', url: '/api/deliveries/direct?token=synthetic-private-token' }
const receipt = effect => ({ schema: 'aiterm.execution-error.v1', code: 'EXECUTION_BUSY', effect, follow_up: 'status_only' })

test('typed execution receipt survives the HTTP500 diagnostic without changing response or fingerprint', async t => {
  const rows = []
  let error, calls = 0
  const bots = new Map(); bots.refresh = async () => {}
  const server = createBellTeamServer({ authorize: () => true, bots,
    diagnostics: { async record(row) { rows.push(row) } },
    messenger: { async sendmessage() { calls++; throw error } } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const baseline = diagnosticReportContext(diagnosticRequestContext(request, [], new Error()))
  for (const effect of ['not_started', 'possible']) {
    for (const representation of ['bridge', 'client']) {
      error = representation === 'bridge'
        ? Object.assign(new Error('synthetic-private-error'), receipt(effect))
        : Object.assign(new Error('synthetic-private-error'), { executionError: receipt(effect) })
      const response = await fetch(`http://127.0.0.1:${server.address().port}${request.url}`, {
        method: 'POST', body: JSON.stringify({ target: 'synthetic-target', message: 'synthetic-private-body' }),
      })
      assert.equal(response.status, 500)
      const body = await response.json()
      assert.deepEqual([body.error, body.effect, body.follow_up], ['EXECUTION_BUSY', effect, 'status_only'])
      const row = rows.at(-1)
      assert.match(row.diagnostic_log, /^execution_code=EXECUTION_BUSY$/mu)
      assert.ok(row.diagnostic_log.split('\n').includes(`execution_effect=${effect}`))
      assert.match(row.diagnostic_log, /^execution_follow_up=status_only$/mu)
      assert.match(row.diagnostic_log, /^delivery_outcome=unknown$/mu)
      assert.doesNotMatch(row.diagnostic_log, /synthetic-private/u)
      // Preserve the established aggregation policy and old unknown-code key.
      assert.deepEqual(diagnosticReportContext(row.diagnostic_log).context, {
        ...baseline.context, failure_stage: 'unknown',
      })
    }
  }
  assert.equal(calls, 4)
  assert.equal(rows.length, 4)
})

test('missing or invalid native metadata never creates execution facts from code text', () => {
  for (const value of [
    new Error('EXECUTION_BUSY: not sent'),
    Object.assign(new Error(), { code: 'EXECUTION_BUSY', effect: 'not_started' }),
    { executionError: { ...receipt('possible'), effect: 'synthetic-private-effect' } },
    { executionError: { ...receipt('possible'), code: 'synthetic-private-code' } },
    { executionError: { ...receipt('possible'), follow_up: 'synthetic-private-follow-up' } },
    { executionError: { ...receipt('possible'), schema: 'wrong-schema' } },
  ]) {
    const context = diagnosticRequestContext(request, [], value)
    assert.doesNotMatch(context, /^execution_/mu)
    assert.doesNotMatch(context, /synthetic-private/u)
  }
})

test('validated metadata records only the existing receipt projection', () => {
  const error = { executionError: { ...receipt('possible'), arbitrary: 'synthetic-private-extra' } }
  const context = diagnosticRequestContext(request, [], error)
  assert.match(context, /^execution_code=EXECUTION_BUSY$/mu)
  assert.match(context, /^execution_effect=possible$/mu)
  assert.doesNotMatch(context, /synthetic-private/u)
  assert.equal(context.split('\n').filter(line => line.startsWith('execution_')).length, 3)
})
