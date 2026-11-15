import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { recordSlowOrAborted } from '../src/http-request-log.mjs'
import { httpRouteType } from '../src/http-errors.mjs'

const fakeResponse = (contentType = 'application/json') => Object.assign(new EventEmitter(), { headersSent: false, statusCode: 200, getHeader: () => contentType })

test('t20: a public API request closed by the client first, or taking 60 s or more, is recorded by route type only', async () => {
  const rows = [], diagnostics = { record: async row => rows.push(row) }
  let clock = 1_000
  const now = () => clock
  // Client closed first (an app 60 s timeout): no finish before close.
  let response = fakeResponse()
  recordSlowOrAborted({ method: 'GET', url: '/api/bots/bot-a/screen?x=1' }, response, diagnostics, now)
  clock += 60_500; response.emit('close'); await new Promise(setImmediate)
  // Finished in time: not recorded.
  response = fakeResponse()
  recordSlowOrAborted({ method: 'GET', url: '/api/queue' }, response, diagnostics, now)
  clock += 1_000; response.emit('finish'); response.emit('close'); await new Promise(setImmediate)
  // Finished but slow: recorded with its status.
  response = Object.assign(fakeResponse(), { headersSent: true })
  recordSlowOrAborted({ method: 'POST', url: '/api/bots/bot-a/messages' }, response, diagnostics, now)
  clock += 61_000; response.emit('finish'); response.emit('close'); await new Promise(setImmediate)
  // Event streams and non-API paths are never recorded.
  response = fakeResponse('text/event-stream')
  recordSlowOrAborted({ method: 'GET', url: '/api/bots/bot-a/messages' }, response, diagnostics, now); response.emit('close')
  recordSlowOrAborted({ method: 'GET', url: '/api/events' }, fakeResponse(), diagnostics, now)
  recordSlowOrAborted({ method: 'GET', url: '/index.html' }, fakeResponse(), diagnostics, now)
  await new Promise(setImmediate)
  assert.equal(rows.length, 2)
  const [closed, slow] = rows.map(row => ({ code: row.code, ...JSON.parse(row.diagnostic_log) }))
  assert.deepEqual(closed, { code: 'SERVER_HTTP_SLOW_OR_ABORTED', schema: 'bellteam.http-slow.v1', http_method: 'GET', request_route: '/api/bots/:id/screen',
    request_started_at_ms: 1_000, duration_ms: 60_500, response_headers_sent: false, response_finished: false, http_status: null, ending: 'client_closed_first' })
  assert.equal(slow.ending, 'slow'); assert.equal(slow.http_status, 200); assert.equal(slow.request_route, '/api/bots/:id/messages'); assert.equal(slow.duration_ms, 61_000)
  assert.equal(httpRouteType('/api/bots/bot-a/secret-value?token=x'), '/api/other') // never an id or query
})
