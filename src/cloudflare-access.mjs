import { createRemoteJWKSet, errors, jwtVerify } from 'jose'

// 鍵（JWKS）は10分ごとにCloudflareから取り直される。その通信が一瞬切れると、joseは古い鍵を使わずに投げる。
// 一時的な失敗が多いので、少し待って1回だけやり直す（2026-10-04 21:39 JST の SERVER_HTTP_500）。
const KEY_FETCH_RETRY_MS = 300

// Token verification errors mean the caller's JWT is invalid/expired (-> 401); JWKS fetch timeouts and upstream 5xx/non-200 errors are transient (-> retry, then 5xx).
const isTokenRejection = error => error instanceof errors.JWTExpired
  || error instanceof errors.JWSSignatureVerificationFailed
  || error instanceof errors.JWTClaimValidationFailed
  || error instanceof errors.JWTInvalid
  || error instanceof errors.JWSInvalid
  || error instanceof errors.JWKSNoMatchingKey
  || error instanceof errors.JOSEAlgNotAllowed // the caller's own token (odd alg/header): a retry cannot heal it
  || error instanceof errors.JOSENotSupported

export function cloudflareAccessAuthorizer({ teamDomain, audience, keySet, retryDelayMs = KEY_FETCH_RETRY_MS } = {}) {
  if (!teamDomain || !audience) throw new Error('BELLTEAM_CLOUDFLARE_ACCESS_CONFIG_REQUIRED')
  const issuer = `https://${teamDomain}`
  const keys = keySet ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`))

  return async request => {
    const assertion = request.headers['cf-access-jwt-assertion']
    if (typeof assertion !== 'string' || !assertion) return false
    try {
      try {
        await jwtVerify(assertion, keys, { issuer, audience })
      } catch (error) {
        if (isTokenRejection(error)) throw error
        await new Promise(resolve => setTimeout(resolve, retryDelayMs))
        await jwtVerify(assertion, keys, { issuer, audience })
      }
      return true
    } catch (error) {
      if (isTokenRejection(error)) return false
      throw error
    }
  }
}
