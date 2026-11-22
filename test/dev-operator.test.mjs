import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertPrivateHttp, startDevOperator } from '../services/subscriptions/dev-operator.mjs'

const freePort = () => new Promise(ok => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)) }) })

test('the dev operator refuses a public origin and starts nothing', async () => {
  for (const bad of ['https://bellteam-login-test.kitepon.dev', 'http://example.com', 'http://8.8.8.8:80', 'http://172.32.0.1', 'https://127.0.0.1:8790', 'http://192.169.1.1', 'nope']) {
    assert.throws(() => assertPrivateHttp(bad), /private|not a URL/, bad)
    await assert.rejects(startDevOperator({ publicUrl: bad, dataDir: join(tmpdir(), 'never-made') }), /private|not a URL/)
  }
  for (const ok of ['http://127.0.0.1:8790', 'http://localhost:1', 'http://[::1]:1', 'http://10.1.2.3:1', 'http://172.16.0.1:1', 'http://172.31.255.1:1', 'http://192.168.1.2:1']) assert.doesNotThrow(() => assertPrivateHttp(ok), ok)
})

test('at a private address web sign-in works through /dev/websignin with a loopback callback origin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-operator-'))
  const lines = []
  const port = await freePort()
  const op = await startDevOperator({ publicUrl: `http://127.0.0.2:${port}`, dataDir: dir, log: l => lines.push(l) })
  try {
    assert.match(lines.join('\n'), new RegExp(`web sign-in callback http://127\\.0\\.0\\.1:${port}`))
    const post = (path, body) => fetch(`${op.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const secret = 'device-secret-0123456789abcdef'
    const ret = 'http://127.0.0.1:51234/abcdefghijklmnopqrstuv'
    const started = await (await post('/auth/v1/websignin/start', { provider: 'google', return: ret, secretHash: createHash('sha256').update(secret).digest('hex') })).json()
    assert.ok(started.loginId, JSON.stringify(started))
    const { location } = await (await post('/dev/websignin', { providerUrl: started.providerUrl, sub: 'desktop-person' })).json()
    assert.equal(new URL(location).origin, `http://127.0.0.1:${port}`)
    const back = await fetch(`${op.url}${new URL(location).pathname}${new URL(location).search}`, { redirect: 'manual' })
    assert.equal(back.status, 302)
    const result = new URL(back.headers.get('location')).searchParams.get('result')
    const taken = await (await post('/auth/v1/websignin/take', { loginId: started.loginId, secret, resultCode: result })).json()
    assert.ok(taken.pass && taken.k)
  } finally { await op.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('an unknown App Store transaction id (an Xcode StoreKit test purchase) is read back as live, then ended by /dev/store-end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-operator-'))
  const port = await freePort()
  const op = await startDevOperator({ publicUrl: `http://127.0.0.1:${port}`, dataDir: dir, log: () => {} })
  try {
    const post = (path, body, pass) => fetch(`${op.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(pass ? { authorization: `Bearer ${pass}` } : {}) }, body: JSON.stringify(body) })
    const { nonce } = await (await post('/auth/v1/signin/nonce', {})).json()
    const { id_token } = await (await post('/dev/id-token', { provider: 'apple', nonce })).json()
    const signed = await (await post('/auth/v1/signin', { provider: 'apple', idToken: id_token, nonce })).json()
    const receipts = [{ store: 'apple', transactionId: '2000000987654321' }]
    const bought = await (await post('/auth/v1/receipt', { receipts }, signed.pass)).json()
    assert.equal(bought.receiptResults[0].result, 'attached')
    assert.ok(bought.entitlements.length > 0)
    assert.equal((await post('/dev/store-end', { transactionId: 'x' })).status, 400)
    assert.equal((await post('/dev/store-end', { transactionId: '2000000987654321' })).status, 200)
    const ended = await (await post('/auth/v1/receipt', { receipts }, bought.pass ?? signed.pass)).json()
    assert.equal(ended.receiptResults[0].result, 'ended')
    assert.equal((await post('/dev/store-reset', {})).status, 200)
    const fresh = await (await post('/auth/v1/receipt', { receipts }, signed.pass)).json()
    assert.equal(fresh.receiptResults[0].result, 'attached', 'after store-reset the same id is read as a fresh live one')
    await post('/dev/store-end', { transactionId: '2000000987654321' })
    const checked = await (await post('/auth/v1/check', {}, ended.pass ?? bought.pass ?? signed.pass)).json()
    assert.equal(checked.entitlements?.length ?? 0, 0, 'check shows no entitlement right after store-end (no kept answer)')
  } finally { await op.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('a client signs in with a fake id token, buys in the fake store, and a restart keeps the keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-operator-'))
  const port = await freePort()
  const lines = []
  const publicUrl = `http://127.0.0.1:${port}`
  let op = await startDevOperator({ publicUrl, dataDir: dir, log: l => lines.push(l) })
  try {
    assert.equal(statSync(join(dir, 'dev-keys.json')).mode & 0o777, 0o600)
    const post = (path, body, pass) => fetch(`${op.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(pass ? { authorization: `Bearer ${pass}` } : {}) }, body: JSON.stringify(body) })
    const k = {}
    for (const provider of ['apple', 'google']) {
      const { nonce } = await (await post('/auth/v1/signin/nonce', {})).json()
      const { id_token } = await (await post('/dev/id-token', { provider, sub: `buyer-${provider}`, nonce })).json()
      const signed = await (await post('/auth/v1/signin', { provider, idToken: id_token, nonce })).json()
      assert.ok(signed.pass && signed.k, provider)
      k[provider] = signed.k
      const bought = await (await post('/dev/store-purchase', { provider, k: signed.k })).json()
      assert.equal(bought.route, '/auth/v1/receipt')
      const got = await (await post(bought.route, { receipts: bought.receipts }, signed.pass)).json()
      assert.equal(got.receiptResults[0]?.result, 'attached', provider)
      assert.ok(got.entitlements.length > 0, provider)
    }
    assert.equal((await post('/dev/store-purchase', { provider: 'x' })).status, 400)
    assert.equal((await post('/dev/id-token', { provider: 'x' })).status, 400)
    assert.match(lines.join('\n'), /wire base http:\/\/127\.0\.0\.1:\d+\/auth\/v1/)
    await op.close()
    // Same data dir, same keys: the same person has the same account number.
    op = await startDevOperator({ publicUrl, dataDir: dir, log: () => {} })
    const post2 = (path, body) => fetch(`${op.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const { nonce } = await (await post2('/auth/v1/signin/nonce', {})).json()
    const { id_token } = await (await post2('/dev/id-token', { provider: 'apple', sub: 'buyer-apple', nonce })).json()
    assert.equal((await (await post2('/auth/v1/signin', { provider: 'apple', idToken: id_token, nonce })).json()).k, k.apple)
  } finally { await op.close(); rmSync(dir, { recursive: true, force: true }) }
})
