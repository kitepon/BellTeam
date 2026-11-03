import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Diagnostics } from '../src/diagnostics.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'

async function serve(t, options) {
  const server = createBellTeamServer({ authorize: async () => true, writeLog() {}, ...options })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}`
}

test('型付き503は共通refresh段階と固定code/型routeだけを保存し再読込できる', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-http503-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'diagnostics.json')
  const diagnostics = new Diagnostics(file)
  await diagnostics.initialize()
  let error = Object.assign(new Error('private-error-message'), {
    code: 'MEMBERS_NOT_ACCEPTED', status: 503, publicMessage: '既存の応答文',
    cause: new Error('private-cause'),
  })
  error.stack = 'private-stack'
  const base = await serve(t, { diagnostics, bots: { refresh() { throw error } } })
  const routes = new Map([
    ['/api/bots/private-bot/messages', '/api/bots/:id/messages'],
    ['/api/bots/private-bot/queue', '/api/bots/:id/queue'],
    ['/api/bots', '/api/bots'], ['/api/owner', '/api/owner'], ['/api/rooms', '/api/rooms'],
  ])
  for (const [route, expected] of routes) {
    const before = Date.now()
    const response = await fetch(`${base}${route}?private-query`, { headers: { 'x-private': 'private-header' } })
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'MEMBERS_NOT_ACCEPTED', message: '既存の応答文' })
    const row = diagnostics.list()[0]
    const log = JSON.parse(row.diagnostic_log)
    assert.equal(row.category, 'SERVER_HTTP_503')
    assert.equal(log.error_code, 'MEMBERS_NOT_ACCEPTED')
    assert.equal(log.http_method, 'GET')
    assert.equal(log.http_stage, 'members_refresh')
    assert.equal(log.request_route, expected)
    assert(log.request_started_at_ms >= before)
    assert(Date.parse(log.response_selected_at) >= log.request_started_at_ms)
    assert.equal(log.members_denial_reason, 'unknown')
    assert.equal(log.members_live_roots, null)
    assert.equal(log.members_failure_phase, 'unknown')
  }
  error = Object.assign(new Error('private-error-message'), { code: 'private-unknown-code', status: 503 })
  const response = await fetch(`${base}/api/private-path?private-query`)
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: error.code, message: error.message })
  const log = JSON.parse(diagnostics.list()[0].diagnostic_log)
  assert.equal(log.error_code, 'unknown')
  assert.equal(log.request_route, '/api/other')
  const saved = await readFile(file, 'utf8')
  assert.doesNotMatch(saved, /private-|既存の応答文/u)
  const reloaded = new Diagnostics(file)
  await reloaded.initialize()
  assert.deepEqual(reloaded.list(), diagnostics.list())
  assert.equal(reloaded.list().length, 1)
  assert.equal(reloaded.list()[0].occurrence_count, 6)
})

test('feature内の503はHTTP段階だけを示しmembers失敗phaseを推測しない', async t => {
  const records = []
  const base = await serve(t, {
    diagnostics: { record: async report => records.push(report) }, bots: { refresh: async () => {} },
    ownerProfile: { get() { throw Object.assign(new Error('safe-public'), { code: 'MEMBERS_NOT_ACCEPTED', status: 503 }) } },
  })
  const response = await fetch(`${base}/api/owner`)
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'MEMBERS_NOT_ACCEPTED', message: 'safe-public' })
  assert.equal(JSON.parse(records[0].diagnostic_log).http_stage, 'feature')
  assert.equal(JSON.parse(records[0].diagnostic_log).members_failure_phase, 'unknown')
})

test('診断保存の失敗と非503は元のHTTP応答と認可を変えない', async t => {
  let writes = 0
  const diagnostics = { record() { writes++; throw new Error('private-writer-error') } }
  const error = Object.assign(new Error('safe-public'), { code: 'MEMBERS_NOT_ACCEPTED', status: 503 })
  const base = await serve(t, { diagnostics, bots: { refresh() { throw error } } })
  const unavailable = await fetch(`${base}/api/bots`)
  assert.equal(unavailable.status, 503)
  assert.deepEqual(await unavailable.json(), { error: error.code, message: error.message })
  assert.equal(writes, 1)
  error.status = 400
  const bad = await fetch(`${base}/api/bots`)
  assert.equal(bad.status, 400)
  assert.deepEqual(await bad.json(), { error: error.code, message: error.message })
  assert.equal(writes, 1)
  const denied = await serve(t, { diagnostics, authorize: async () => false,
    bots: { refresh() { assert.fail('unauthenticated request reached members') } } })
  const unauthorized = await fetch(`${denied}/api/bots`)
  assert.equal(unauthorized.status, 401)
  assert.deepEqual(await unauthorized.json(), { error: 'UNAUTHORIZED' })
  assert.equal(writes, 1)
})

test('内部MCPの503はMCP段階を記録しURL内容を保持しない', async t => {
  const records = []
  const error = Object.assign(new Error('public'), { code: 'MEMBERS_IPC_DISCONNECTED', status: 503 })
  const seatMcp = () => { throw error }
  seatMcp.close = () => {}
  const base = await serve(t, { internal: true, seatMcp,
    diagnostics: { record: async report => records.push(report) } })
  const response = await fetch(`${base}/mcp/private-name?private-query`)
  assert.equal(response.status, 503)
  const log = JSON.parse(records[0].diagnostic_log)
  assert.equal(log.http_stage, 'seat_mcp')
  assert.equal(log.request_route, '/api/other')
  assert.doesNotMatch(records[0].diagnostic_log, /private/u)
})
