import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Diagnostics, createDiagnosticsAdminServer } from '../src/diagnostics.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'

test('messages POST失敗をHTTPから管理診断へ渡し、診断原本に本文・query・認証・対象名を含めない', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-http-context-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'diagnostics.json')
  const diagnostics = new Diagnostics(file)
  await diagnostics.initialize()
  const botId = 'private-bot-name'
  const bots = new Map([[botId, { id: botId }]])
  bots.refresh = async () => {}
  let dispatched = 0
  const server = createBellTeamServer({
    authorize: request => request.headers.authorization === 'Bearer synthetic-client-secret',
    bots, diagnostics,
    messenger: { async enqueueUserTurn({ message }) {
      assert.equal(message, 'synthetic-private-body')
      dispatched++
      const error = new Error('synthetic-error-secret')
      error.stack = `${error.stack.split('\n')[0]}\n    at async AitermTransport.dispatch (file://${process.cwd()}/src/aiterm-transport.mjs:607:18)`
      throw error
    } },
  })
  const admin = createDiagnosticsAdminServer({ diagnostics, key: 'synthetic-admin-secret' })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await new Promise(resolve => admin.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/bots/${botId}/messages?token=synthetic-query-secret`
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401)
    assert.equal(diagnostics.list().length, 0)
    const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer synthetic-client-secret' }, body: JSON.stringify({ message: 'synthetic-private-body' }) })
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: 'INTERNAL_ERROR' })
    assert.equal(dispatched, 1)
    const [row] = await (await fetch(`http://127.0.0.1:${admin.address().port}/api/admin/logs`, { headers: { authorization: 'Bearer synthetic-admin-secret' } })).json()
    assert.equal(row.fingerprint, createHash('sha256').update('SERVER_HTTP_500:server').digest('hex'))
    assert.deepEqual([row.status, row.severity, row.occurrence_count], ['open', 'high', 1])
    for (const line of ['operation=message_send', 'trigger=unknown', 'request_method=POST', 'request_route=/api/bots/:id/messages', 'expected_result=message_acceptance_response', 'expectation_basis=code_contract', 'actual_result=http_500_response_selected', 'result_basis=server_observation', 'failure_stage=dispatch', 'handling_basis=code_classification', 'screen_observation=not_observed', 'response_delivery=unknown', 'delivery_outcome=unknown']) assert.ok(row.diagnostic_log.split('\n').includes(line), line)
    const persisted = await readFile(file, 'utf8')
    assert.doesNotMatch(persisted, /synthetic-(?:private-body|query-secret|client-secret|admin-secret|error-secret)|private-bot-name/u)
    assert.equal(row.diagnostic_log.includes(process.cwd()), false)
    assert.equal(JSON.parse(persisted)[0].diagnostic_log, row.diagnostic_log)
  } finally {
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => admin.close(resolve))])
  }
})

test('未知のHTTP操作の失敗はoperationを作らずunknownで記録する', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-unknown-context-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const diagnostics = new Diagnostics(join(root, 'diagnostics.json'))
  await diagnostics.initialize()
  const server = createBellTeamServer({
    authorize: () => true, diagnostics,
    bots: { async refresh() { throw new Error('synthetic-private-reason') } },
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    for (const path of ['/api/unknown/private-value', '/api/bots/%2F/messages']) {
      assert.equal((await fetch(`http://127.0.0.1:${server.address().port}${path}?key=synthetic-secret`)).status, 500)
      const [row] = diagnostics.list()
      assert.match(row.diagnostic_log, /^operation=unknown$/mu)
      assert.match(row.diagnostic_log, /^expected_result=unknown$/mu)
      assert.match(row.diagnostic_log, /^failure_stage=unknown$/mu)
      assert.match(row.diagnostic_log, /^request_route=\/api\/other$/mu)
      assert.doesNotMatch(row.diagnostic_log, /private-value|synthetic-secret|synthetic-private-reason/u)
    }
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('会話と個別予定のGET失敗はアプリと同じoperationで記録する', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-read-context-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const diagnostics = new Diagnostics(join(root, 'diagnostics.json'))
  await diagnostics.initialize()
  const server = createBellTeamServer({
    authorize: () => true, diagnostics,
    bots: { async refresh() { throw new Error('synthetic-private-reason') } },
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    for (const [path, operation, route, expected] of [
      ['/api/bots/private-bot/messages', 'conversation_read', '/api/bots/:id/messages', 'conversation_data_response'],
      ['/api/bots/private-bot/schedules', 'schedule_read', '/api/bots/:id/schedules', 'schedule_data_response'],
      ['/api/rooms/private-room/schedules', 'schedule_read', '/api/rooms/:id/schedules', 'schedule_data_response'],
    ]) {
      assert.equal((await fetch(`http://127.0.0.1:${server.address().port}${path}?key=synthetic-secret`)).status, 500)
      const [row] = diagnostics.list()
      for (const field of ['scope=server_request', `operation=${operation}`, `request_route=${route}`, `expected_result=${expected}`, 'trigger=unknown', 'result_basis=server_observation']) assert.ok(row.diagnostic_log.split('\n').includes(field), field)
      assert.doesNotMatch(row.diagnostic_log, /private-bot|private-room|synthetic-secret/u)
    }
    assert.equal(diagnostics.list()[0].occurrence_count, 3)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
