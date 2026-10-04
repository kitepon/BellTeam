import { createRemoteJWKSet, errors, jwtVerify } from 'jose'

export function cloudflareAccessAuthorizer({ teamDomain, audience, keySet } = {}) {
  if (!teamDomain || !audience) throw new Error('BELLTEAM_CLOUDFLARE_ACCESS_CONFIG_REQUIRED')
  const issuer = `https://${teamDomain}`
  const keys = keySet ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`))

  return async request => {
    const assertion = request.headers['cf-access-jwt-assertion']
    if (typeof assertion !== 'string' || !assertion) return false
    try {
      await jwtVerify(assertion, keys, { issuer, audience })
      return true
    } catch (error) {
      if (error instanceof errors.JOSEError) return false
      throw error
    }
  }
}
