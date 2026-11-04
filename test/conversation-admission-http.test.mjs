import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request } from 'node:http'
import { createBellTeamServer } from '../src/http-server.mjs'
import { ConversationLifetimes, validateConversationAdmissionDiagnostic } from '../src/conversation-lifetimes.mjs'

async function fixture(t, options = {}) {
  const admission = new ConversationLifetimes()
  const server = createBellTeamServer({ bots: { refresh() { assert.fail('diagnostic read must not refresh members') } },
    authorize: req => req.headers.authorization === 'test-owner', messenger: {}, store: {}, transport: {},
    conversationAssembly: { admission, run() { assert.fail('diagnostic read must not enter conversation') } },
    writeLog() {}, ...options })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const path = '/api/diagnostics/conversation-admission', origin = `http://127.0.0.1:${server.address().port}`
  return { admission, origin, path, get: (suffix = '', options = {}) => fetch(origin + path + suffix,
    { headers: { authorization: 'test-owner' }, ...options }) }
}

test('authenticated read binds the actual closed admission without enter or control effects', async t => {
  const f = await fixture(t)
  f.admission.close('module_child_exit')
  const before = f.admission.inspectAdmission(), response = await f.get()
  assert.equal(response.status, 200)
  const value = await response.json()
  assert.deepEqual(Object.keys(value), ['admission'])
  assert(validateConversationAdmissionDiagnostic(value.admission))
  assert.deepEqual(value.admission, before)
  assert.equal(value.admission.ticket, true)
  assert.equal(value.admission.closedBy, 'module_child_exit')
  assert.deepEqual(f.admission.inspectAdmission(), before)
  assert.equal(JSON.stringify(value).includes('generation'), false)
  assert.equal((await fetch(f.origin + f.path)).status, 401)
  assert.equal((await f.get('', { method: 'POST' })).status, 405)
  assert.equal((await f.get('?target=other')).status, 400)
  const status = await new Promise((resolve, reject) => {
    const req = request(f.origin + f.path, { method: 'GET', headers: { authorization: 'test-owner', 'content-length': '2' } }, res => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject); req.end('{}')
  })
  assert.equal(status, 400)
})

test('internal seats and missing or invalid providers cannot expose or synthesize a diagnostic', async t => {
  const internal = await fixture(t, { internal: true })
  assert.equal((await internal.get()).status, 403)
  const missing = await fixture(t, { conversationAssembly: null })
  assert.equal((await missing.get()).status, 503)
  const invalid = await fixture(t, { conversationAssembly: { admission: { inspectAdmission: () => ({ generation: 'private' }) } } })
  const response = await invalid.get()
  assert.equal(response.status, 503)
  assert.equal((await response.text()).includes('private'), false)
})
