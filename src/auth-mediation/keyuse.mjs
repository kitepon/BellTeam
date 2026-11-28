import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

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
