import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Diagnostics } from '../src/diagnostics.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'

async function server(t, diagnostics) {
  const instance = createBellTeamServer({ authorize: () => true, diagnostics,
    bots: { async refresh() { throw new Error('private failure content') } } })
  instance.listen(0, '127.0.0.1')
  await once(instance, 'listening')
  t.after(() => new Promise(resolve => instance.close(resolve)))
  return `http://127.0.0.1:${instance.address().port}`
}

test('500応答は今回保存した診断の既存指紋・回数・受信時刻を返し、原因本文は返さない', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-error-reference-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'diagnostics.json'), diagnostics = new Diagnostics(file)
  await diagnostics.initialize()
  const base = await server(t, diagnostics)
  for (const path of ['/api/bots', '/api/bots/bot-a/messages']) {
    for (const count of [1, 2]) {
      const response = await fetch(base + path)
      assert.equal(response.status, 500)
      assert.deepEqual(await response.json(), { error: 'INTERNAL_ERROR' })
      const fingerprint = response.headers.get('X-BellTeam-Diagnostic-Fingerprint')
      assert.match(fingerprint, /^[a-f0-9]{64}$/u)
      const row = JSON.parse(await readFile(file, 'utf8')).find(row => row.fingerprint === fingerprint)
      assert.equal(row.occurrence_count, count)
      assert.equal(response.headers.get('X-BellTeam-Diagnostic-Occurrence-Count'), String(count))
      assert.equal(response.headers.get('X-BellTeam-Diagnostic-Received-At'), row.diagnostic_log_received_at)
      assert.doesNotMatch(JSON.stringify([...response.headers]), /private failure content|Bearer|\n\s*at /u)
    }
  }
})

test('診断の保存失敗時は存在しない参照を返さず、元の500応答を保つ', async t => {
  const base = await server(t, { async record() { throw new Error('storage unavailable') } })
  const response = await fetch(base + '/api/bots')
  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), { error: 'INTERNAL_ERROR' })
  for (const name of ['Fingerprint', 'Occurrence-Count', 'Received-At'])
    assert.equal(response.headers.get(`X-BellTeam-Diagnostic-${name}`), null)
})

test('Appleが受けた500の参照はPOST後の診断に原文のまま残る', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-error-reference-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'diagnostics.json'), diagnostics = new Diagnostics(file)
  await diagnostics.initialize()
  const base = await server(t, diagnostics)
  const failed = await fetch(base + '/api/bots')
  const [fingerprint, count, receivedAt] = ['Fingerprint', 'Occurrence-Count', 'Received-At']
    .map(name => failed.headers.get(`X-BellTeam-Diagnostic-${name}`))
  // Swiftの`testServerErrorReportPostsDiagnosticReference`がPOSTする本文と同じ項目。
  const reference = `server_diagnostic_fingerprint=${fingerprint}\nserver_diagnostic_occurrence_count=${count}\nserver_diagnostic_received_at=${receivedAt}`
  const posted = await fetch(base + '/api/diagnostics', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'IOS_HTTP_5XX', module: 'bots', app_version: '1.0.3 (90)', severity: 'warn',
      diagnostic_log: `module=bots\nerror_domain=BellAPIError\nhttp_status=500\nhttp_method=GET\nrequest_route=/api/bots\nrequest_method=GET\nrequest_attempts=1\n${reference}\nseverity=warn` }) })
  assert.equal(posted.status, 202)
  const rows = JSON.parse(await readFile(file, 'utf8'))
  const server500 = rows.find(row => row.category === 'SERVER_HTTP_500'), apple = rows.find(row => row.category === 'IOS_HTTP_5XX')
  assert.equal(server500.fingerprint, fingerprint)
  assert.equal(String(server500.occurrence_count), count)
  assert.equal(server500.diagnostic_log_received_at, receivedAt)
  assert.ok(apple.diagnostic_log.includes(reference))
})
