import { createRemoteJWKSet, errors, jwtVerify } from 'jose'

// 鍵（JWKS）は10分ごとにCloudflareから取り直される。その通信が一瞬切れると、joseは古い鍵を使わずに投げる。
// 一時的な失敗が多いので、少し待って1回だけやり直す（2026-10-04 21:39 JST の SERVER_HTTP_500）。
const KEY_FETCH_RETRY_MS = 300

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
        // 署名や期限の誤りはJOSEError。それ以外は鍵を取りに行く通信の失敗。
        if (error instanceof errors.JOSEError) throw error
        await new Promise(resolve => setTimeout(resolve, retryDelayMs))
        await jwtVerify(assertion, keys, { issuer, audience })
      }
      return true
    } catch (error) {
      if (error instanceof errors.JOSEError) return false
      throw error
    }
  }
}
