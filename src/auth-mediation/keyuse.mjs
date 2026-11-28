import { constants, createCipheriv, createDecipheriv, createHmac, createPrivateKey, privateEncrypt, randomBytes, sign } from 'node:crypto'

// Key use inside the module: the key never leaves, only the result does. One AES-256-GCM operation; no state, so rotation is the caller's (unwrap with the old name, wrap with the new).
// Blob = base64(nonce 12 B | ciphertext | tag 16 B); aad (the caller's context, e.g. a ledger id) is authenticated, so a blob cannot be moved to another context.
export const KEY_FIELD = 'wrap_key' // lower-case on purpose: the exec transports only return upper-case labels, so this field never leaves
const refuse = () => Object.assign(new Error('KEYUSE_REFUSED'), { code: 'KEYUSE_REFUSED' })
const keyOf = fields => {
  const key = Buffer.from(fields?.[KEY_FIELD] ?? '', 'base64')
  if (key.length !== 32) throw refuse()
  return key
}
const b64 = /^[A-Za-z0-9+/]*={0,2}$/u

export function useKey(action, fields, data, aad = '') {
  if (typeof data !== 'string' || !b64.test(data) || data.length > 4096) throw refuse()
  const input = Buffer.from(data, 'base64'), context = Buffer.from(aad, 'utf8')
  const key = keyOf(fields)
  if (action === 'wrap') {
    if (input.length < 1 || input.length > 1024) throw refuse()
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(context)
    return Buffer.concat([nonce, cipher.update(input), cipher.final(), cipher.getAuthTag()]).toString('base64')
  }
  if (action === 'unwrap') {
    if (input.length < 12 + 1 + 16) throw refuse()
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, input.subarray(0, 12))
      decipher.setAAD(context); decipher.setAuthTag(input.subarray(-16))
      return Buffer.concat([decipher.update(input.subarray(12, -16)), decipher.final()]).toString('base64')
    } catch { throw refuse() }
  }
  throw refuse()
}

// Sign (F15): a signature or MAC made inside the module. The algorithm is the item's (sign_alg), never the caller's, and the key type must match it.
// ES* answers the raw r||s form JWT uses. The caller builds what is signed and assembles the result; it never sees the key.
const SIGNING = { ES256: { hash: 'sha256', curve: 'prime256v1', type: 'ec' }, ES384: { hash: 'sha384', curve: 'secp384r1', type: 'ec' }, RS256: { hash: 'sha256', type: 'rsa' },
  EdDSA: { hash: null, type: 'ed25519' }, HS256: { hash: 'sha256' }, HS384: { hash: 'sha384' }, HS512: { hash: 'sha512' } }
export function signData(fields, data) {
  const spec = SIGNING[fields?.sign_alg]
  if (!spec || typeof data !== 'string' || !b64.test(data) || data.length > 4096 || !fields.sign_key) throw refuse()
  const input = Buffer.from(data, 'base64')
  if (input.length < 1 || input.length > 3072) throw refuse()
  if (!spec.type) return createHmac(spec.hash, Buffer.from(fields.sign_key, 'utf8')).update(input).digest('base64')
  let key
  try { key = createPrivateKey(fields.sign_key) } catch { throw refuse() }
  if (key.asymmetricKeyType !== spec.type || (spec.curve && key.asymmetricKeyDetails?.namedCurve !== spec.curve)) throw refuse()
  return sign(spec.hash, input, spec.type === 'ec' ? { key, dsaEncoding: 'ieee-p1363' } : key).toString('base64')
}

// Sign a digest (F15): RSASSA-PKCS1-v1_5 over a SHA-256, SHA-384 or SHA-512 digest (32, 48 or 64 bytes: the hash follows the length) the caller already computed, for tools whose signature provider hashes locally
// (Android jarsigner / apksigner; apksigner picks SHA-512 for RSA keys above 3072 bits). Only an RS256 item takes it; the DigestInfo prefixes are fixed here, so the caller cannot make the module sign anything but a SHA-2 value.
const DIGEST_INFO = { 32: Buffer.from('3031300d060960864801650304020105000420', 'hex'), 48: Buffer.from('3041300d060960864801650304020205000430', 'hex'), 64: Buffer.from('3051300d060960864801650304020305000440', 'hex') } // SHA-256 / SHA-384 / SHA-512 by length
export function signDigest(fields, data) {
  if (fields?.sign_alg !== 'RS256' || !fields.sign_key || typeof data !== 'string' || !b64.test(data)) throw refuse()
  const digest = Buffer.from(data, 'base64')
  if (!DIGEST_INFO[digest.length]) throw refuse()
  let key
  try { key = createPrivateKey(fields.sign_key) } catch { throw refuse() }
  if (key.asymmetricKeyType !== 'rsa') throw refuse()
  return privateEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.concat([DIGEST_INFO[digest.length], digest])).toString('base64')
}
