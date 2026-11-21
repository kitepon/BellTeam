import assert from 'node:assert/strict'
import test from 'node:test'
import { createWebPushOrigin } from '../src/web-push-origin.mjs'

test('only saved HTTPS configuration determines the origin and every call sees the latest saved value', () => {
  let publicUrl = 'https://owner.example:443/path'
  const check = createWebPushOrigin({ settings: { configuration: id => { assert.equal(id, 'cloudflare'); return { publicUrl } } } })
  const request = { headers: { origin: 'https://owner.example:443', host: 'evil.example', 'x-forwarded-host': 'evil.example' } }
  assert.equal(check(request), 'https://owner.example')
  publicUrl = 'https://new.example:8443/'
  assert.throws(() => check(request), { code: 'WEB_PUSH_ORIGIN_FORBIDDEN', status: 403 })
  request.headers.origin = 'https://new.example:8443'
  assert.equal(check(request), 'https://new.example:8443')
  for (const value of ['', 'http://owner.example', 'not a URL', 'https://user:pass@owner.example']) {
    publicUrl = value
    assert.throws(() => check(request), { code: 'WEB_PUSH_ORIGIN_UNAVAILABLE', status: 503 })
  }
})

test('missing, null, multiple, cross-site and non-origin values reject without inspecting body or endpoint', () => {
  const check = createWebPushOrigin({ settings: { configuration: () => ({ publicUrl: 'https://owner.example/' }) } })
  const headers = [ {}, { origin: 'null' }, { origin: ['https://owner.example'] },
    { origin: 'https://owner.example, https://owner.example' }, { origin: 'https://other.example' },
    { origin: 'https://owner.example/path' }, { origin: 'https:owner.example' }, { origin: 'https://owner.example\\' }, { origin: 'https://owner.example?q=1' },
    { origin: 'https://user@owner.example' }, { origin: 'https://owner.example#x' },
    { origin: ' https://owner.example' }, { origin: 'https://owner.example\n' },
    ...['same-site', 'cross-site', 'none', ['same-origin']].map(site => ({ origin: 'https://owner.example', 'sec-fetch-site': site })) ]
  for (const value of headers) assert.throws(() => check({ headers: value }), { code: 'WEB_PUSH_ORIGIN_FORBIDDEN', status: 403 })
  assert.throws(() => check({ headers: { origin: 'https://owner.example' }, rawHeaders: ['Origin', 'https://owner.example', 'origin', 'https://owner.example'] }), { status: 403 })
  assert.equal(check({ headers: { origin: 'https://owner.example', 'sec-fetch-site': 'same-origin' }, get body() { throw new Error('body must not supply authority') } }), 'https://owner.example')
})
