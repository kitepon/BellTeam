import assert from 'node:assert/strict'
import test from 'node:test'

import { generateKeyPair, SignJWT } from 'jose'

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
