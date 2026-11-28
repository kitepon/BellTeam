import assert from 'node:assert/strict'
import test from 'node:test'

import { errors, generateKeyPair, SignJWT } from 'jose'

import { cloudflareAccessAuthorizer } from '../src/cloudflare-access.mjs'

test('Cloudflare Access JWTの署名・発行元・audience・期限を検証する', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const { privateKey: otherKey } = await generateKeyPair('RS256')
  const authorize = cloudflareAccessAuthorizer({
    teamDomain: 'team.cloudflareaccess.com', audience: 'bellteam-aud', keySet: publicKey,
  })
  const request = assertion => ({ headers: { 'cf-access-jwt-assertion': assertion } })
  const sign = (key, issuer, audience, expires = '1h') => new SignJWT({ email: 'owner@example.com' })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(key)

  assert.equal(await authorize({ headers: {} }), false)
  assert.equal(await authorize(request(await sign(privateKey, 'https://team.cloudflareaccess.com', 'bellteam-aud'))), true)
  assert.equal(await authorize(request(await sign(otherKey, 'https://team.cloudflareaccess.com', 'bellteam-aud'))), false)
  assert.equal(await authorize(request(await sign(privateKey, 'https://other.cloudflareaccess.com', 'bellteam-aud'))), false)
  assert.equal(await authorize(request(await sign(privateKey, 'https://team.cloudflareaccess.com', 'other-aud'))), false)
  assert.equal(await authorize(request(await sign(privateKey, 'https://team.cloudflareaccess.com', 'bellteam-aud', '-1s'))), false)
})

test('鍵の取得が一度だけ失敗した時は、やり直して通す。続けて失敗した時は投げる', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const assertion = await new SignJWT({ email: 'owner@example.com' })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer('https://team.cloudflareaccess.com').setAudience('bellteam-aud')
    .setIssuedAt().setExpirationTime('1h').sign(privateKey)
  const request = { headers: { 'cf-access-jwt-assertion': assertion } }
  // joseが鍵を取りに行く所（keySet）で、Nodeのfetchと同じ形の失敗を起こす。
  const failing = failures => {
    let calls = 0
    const keySet = async () => {
      if (++calls <= failures) throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' }) })
      return publicKey
    }
    return { keySet, calls: () => calls }
  }

  const once = failing(1)
  const recovered = cloudflareAccessAuthorizer({ teamDomain: 'team.cloudflareaccess.com', audience: 'bellteam-aud', keySet: once.keySet, retryDelayMs: 1 })
  assert.equal(await recovered(request), true)
  assert.equal(once.calls(), 2)

  const twice = failing(2)
  const down = cloudflareAccessAuthorizer({ teamDomain: 'team.cloudflareaccess.com', audience: 'bellteam-aud', keySet: twice.keySet, retryDelayMs: 1 })
  await assert.rejects(down(request), error => error instanceof TypeError && error.message === 'fetch failed')
  assert.equal(twice.calls(), 2)
})

test('署名が合わないJWTは、鍵の取得をやり直さずに拒む', async () => {
  const { publicKey } = await generateKeyPair('RS256')
  const { privateKey: otherKey } = await generateKeyPair('RS256')
  const assertion = await new SignJWT({}).setProtectedHeader({ alg: 'RS256' })
    .setIssuer('https://team.cloudflareaccess.com').setAudience('bellteam-aud').setExpirationTime('1h').sign(otherKey)
  let calls = 0
  const authorize = cloudflareAccessAuthorizer({
    teamDomain: 'team.cloudflareaccess.com', audience: 'bellteam-aud', retryDelayMs: 1,
    keySet: async () => { calls += 1; return publicKey },
  })
  assert.equal(await authorize({ headers: { 'cf-access-jwt-assertion': assertion } }), false)
  assert.equal(calls, 1)
})

test('JWKS取得のタイムアウトや非200応答のJOSEErrorは401にせずリトライし、続けば投げる', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const assertion = await new SignJWT({}).setProtectedHeader({ alg: 'RS256' })
    .setIssuer('https://team.cloudflareaccess.com').setAudience('bellteam-aud').setExpirationTime('1h').sign(privateKey)
  const req = { headers: { 'cf-access-jwt-assertion': assertion } }

  let calls = 0
  const recovered = cloudflareAccessAuthorizer({
    teamDomain: 'team.cloudflareaccess.com', audience: 'bellteam-aud', retryDelayMs: 1,
    keySet: async () => { if (++calls === 1) throw new errors.JWKSTimeout(); return publicKey },
  })
  assert.equal(await recovered(req), true)
  assert.equal(calls, 2)

  let failedCalls = 0
  const down = cloudflareAccessAuthorizer({
    teamDomain: 'team.cloudflareaccess.com', audience: 'bellteam-aud', retryDelayMs: 1,
    keySet: async () => { failedCalls += 1; throw new errors.JOSEError('Expected 200 OK from the JSON Web Key Set HTTP response') },
  })
  await assert.rejects(down(req), error => error instanceof errors.JOSEError)
  assert.equal(failedCalls, 2)
})

test('alg none / an unknown alg in the caller\'s own token is a 401 (false) at once, not a retried 5xx', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const good = await new SignJWT({}).setProtectedHeader({ alg: 'RS256' })
    .setIssuer('https://team.cloudflareaccess.com').setAudience('bellteam-aud').setExpirationTime('1h').sign(privateKey)
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const [, payload, signature] = good.split('.')
  let calls = 0
  const authorize = cloudflareAccessAuthorizer({ teamDomain: 'team.cloudflareaccess.com', audience: 'bellteam-aud', retryDelayMs: 1, keySet: async () => { calls += 1; return publicKey } })
  for (const alg of ['none', 'XX999']) assert.equal(await authorize({ headers: { 'cf-access-jwt-assertion': [b64({ alg }), payload, signature].join('.') } }), false)
  assert.equal(calls, 2, 'one key read per token, no retry')
})
