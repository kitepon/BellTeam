import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWebPushOrigin } from '../src/web-push-origin.mjs'
import { staticFile } from '../src/http-assets.mjs'

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

test('fixed service worker has JavaScript MIME and no-cache in both static paths while ordinary assets stay immutable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-sw-cache-'))
  await writeFile(join(root, 'sw.js'), 'const value="__ASSET_VERSION__";')
  await writeFile(join(root, 'application.js'), 'const value=1;')
  const files = new Map([['/sw.js', 'sw.js'], ['/application.js', 'application.js']])
  let versioned = new Set()
  const server = createServer((request, response) => {
    staticFile(response, root, request.url, 'test-version', { files, versioned }).catch(() => { response.writeHead(500); response.end() })
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    for (const set of [new Set(), new Set(['sw.js'])]) {
      versioned = set
      const result = await fetch(base + '/sw.js')
      assert.equal(result.headers.get('cache-control'), 'no-cache')
      assert.equal(result.headers.get('content-type'), 'text/javascript; charset=utf-8')
      assert.match(await result.text(), /const value=/)
    }
    const ordinary = await fetch(base + '/application.js')
    assert.equal(ordinary.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    await ordinary.text()
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true })
  }
})
