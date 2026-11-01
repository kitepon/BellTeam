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
