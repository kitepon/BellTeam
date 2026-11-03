import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDiagnosticsAdminServer } from '../src/diagnostics.mjs'

test('admin module admission closures return fixed 503 while authentication and other failures keep their existing status', async () => {
  let code = 'DIAGNOSTICS_NOT_ACCEPTING', calls = 0
  const unavailable = () => { calls++; throw Object.assign(new Error(code), { code, status: 503 }) }
  const server = createDiagnosticsAdminServer({ diagnostics: { list: unavailable, setStatus: unavailable }, key: 'fixture-key' })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/admin/logs`, headers = { authorization: 'Bearer fixture-key' }
    assert.equal((await fetch(base)).status, 401)
    assert.equal(calls, 0)
    for (code of ['DIAGNOSTICS_NOT_ACCEPTING', 'DIAGNOSTICS_NOT_ACCEPTED', 'DIAGNOSTICS_UNAVAILABLE']) {
      const response = await fetch(base, { headers })
      assert.equal(response.status, 503)
      assert.deepEqual(await response.json(), { error: 'DIAGNOSTICS_UNAVAILABLE' })
    }
    const closedWrite = await fetch(`${base}/resolve`, { method: 'POST', headers, body: JSON.stringify({ fingerprint: 'a'.repeat(64) }) })
    assert.equal(closedWrite.status, 503)
    code = 'SYNTHETIC_OTHER_FAILURE'
    const other = await fetch(base, { headers })
    assert.equal(other.status, 500)
    assert.deepEqual(await other.json(), { error: 'INTERNAL_ERROR' })
    assert.equal(calls, 5)
  } finally { await new Promise(resolve => server.close(resolve)) }
})
