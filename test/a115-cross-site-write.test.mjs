import assert from 'node:assert/strict'
import test from 'node:test'
import { crossSiteWrite } from '../src/http-response.mjs'

test('a115: browser cross-site writes are refused; apps, seats and same-origin pages are not', () => {
  const write = (headers, method = 'POST') => crossSiteWrite({ method, headers })
  // Another site's page (modern browser): marked cross-site or same-site, whatever the body.
  assert.equal(write({ 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }), true)
  assert.equal(write({ 'sec-fetch-site': 'cross-site' }), true)
  assert.equal(write({ 'sec-fetch-site': 'same-site', 'content-type': 'application/json' }, 'DELETE'), true)
  // Older browser without Sec-Fetch-Site: a simple content type with an Origin skips the preflight.
  assert.equal(write({ origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }), true)
  assert.equal(write({ origin: 'https://evil.example', 'content-type': 'multipart/form-data; boundary=x' }), true)
  // BellTeam's Web UI, apps (URLSession / HttpClient) and node fetch in seats and tests.
  assert.equal(write({ 'sec-fetch-site': 'same-origin', origin: 'https://bell.example', 'content-type': 'application/json' }), false)
  assert.equal(write({ 'sec-fetch-site': 'same-origin', origin: 'https://bell.example' }), false)
  assert.equal(write({ 'content-type': 'application/json' }), false)
  assert.equal(write({ 'content-type': 'text/plain;charset=UTF-8' }), false)
  assert.equal(write({}), false)
  // Reads are never refused here.
  assert.equal(write({ 'sec-fetch-site': 'cross-site' }, 'GET'), false)
  // a128: browsers without Sec-Fetch-Site: a foreign Origin is refused even with no body; this site's own Origin passes.
  assert.equal(write({ origin: 'https://evil.example', host: 'bell.example' }), true)
  assert.equal(write({ origin: 'null', host: 'bell.example' }), true)
  assert.equal(write({ origin: 'https://bell.example', host: 'bell.example' }), false)
  assert.equal(write({ origin: 'http://localhost:18891', host: 'localhost:18891' }), false)
  assert.equal(crossSiteWrite({ method: 'POST', headers: { origin: 'https://bell.example', host: 'localhost:18891' } }, 'https://bell.example'), false) // proxy rewrote Host
  assert.equal(crossSiteWrite({ method: 'POST', headers: { origin: 'https://evil.example', host: 'localhost:18891' } }, 'https://bell.example'), true)
})
