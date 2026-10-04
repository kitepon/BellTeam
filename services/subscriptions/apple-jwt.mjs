const encoder = new TextEncoder()

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export async function importAppleSigningKey(pem) {
  const der = Uint8Array.from(atob(pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/gu, '')), character => character.charCodeAt(0))
  return crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
}

export async function createAppleJWT(key, { keyId, issuerId, bundleId }, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000)
  const header = base64url(encoder.encode(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' })))
  const payload = base64url(encoder.encode(JSON.stringify({
    iss: issuerId, iat: issuedAt, exp: issuedAt + 300, aud: 'appstoreconnect-v1', bid: bundleId,
  })))
  const message = `${header}.${payload}`
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(message)))
  return `${message}.${base64url(signature)}`
}
