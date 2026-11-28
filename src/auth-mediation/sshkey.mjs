import { createPrivateKey, sign } from 'node:crypto'

// SSH agent operations inside the module (README F16). The key is an unencrypted OpenSSH private key in item "sshkey <name>" (field ssh_key); it signs here and never leaves.
// ssh-identity answers the public key blob, ssh-sign the SSH signature blob (string algorithm, string signature) for the agent's bytes.
const refuse = () => Object.assign(new Error('SSHKEY_REFUSED'), { code: 'SSHKEY_REFUSED' })
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
const str = b => Buffer.concat([u32(b.length), Buffer.isBuffer(b) ? b : Buffer.from(b)])
const mpint = b => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; const t = b.subarray(i); return str(t[0] & 0x80 ? Buffer.concat([Buffer.from([0]), t]) : t) }
const unsigned = b => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; return b.subarray(i) }
const url = b => unsigned(b).toString('base64url')

function reader(buffer) {
  let at = 0
  const take = n => { if (at + n > buffer.length) throw refuse(); const out = buffer.subarray(at, at + n); at += n; return out }
  return { u32: () => take(4).readUInt32BE(), string: () => take(take(4).readUInt32BE()), rest: () => buffer.subarray(at) }
}

// The OpenSSH key container: magic, cipher, kdf, kdf options, key count, public blob, private block (check ints, key, comment). Encrypted keys are refused.
export function parseOpenSshKey(text) {
  const body = String(text).replace(/-----(BEGIN|END) OPENSSH PRIVATE KEY-----/gu, '').replace(/\s+/gu, '')
  const raw = Buffer.from(body, 'base64'), magic = Buffer.from('openssh-key-v1\0')
  if (!raw.subarray(0, magic.length).equals(magic)) throw refuse()
  const r = reader(raw.subarray(magic.length))
  if (r.string().toString() !== 'none' || r.string().toString() !== 'none') throw refuse()
  r.string()
  if (r.u32() !== 1) throw refuse()
  const publicBlob = r.string(), p = reader(r.string())
  if (p.u32() !== p.u32()) throw refuse()
  const type = p.string().toString()
  let key
  if (type === 'ssh-ed25519') { const pub = p.string(), seed = p.string().subarray(0, 32); key = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: url(seed), x: url(pub) }, format: 'jwk' }) }
  else if (type === 'ssh-rsa') {
    const n = p.string(), e = p.string(), d = p.string(); p.string(); const pp = p.string(), q = p.string()
    const big = b => BigInt('0x' + (unsigned(b).toString('hex') || '0')), hex = v => Buffer.from(v.toString(16).padStart(Math.ceil(v.toString(16).length / 2) * 2, '0'), 'hex')
    const inv = (a, m) => { let [t, nt, r2, nr] = [0n, 1n, m, a % m]; while (nr) { const q2 = r2 / nr; [t, nt] = [nt, t - q2 * nt]; [r2, nr] = [nr, r2 - q2 * nr] } return (t + m) % m }
    const P = big(pp), Q = big(q), D = big(d)
    key = createPrivateKey({ key: { kty: 'RSA', n: url(n), e: url(e), d: url(d), p: url(pp), q: url(q), dp: url(hex(D % (P - 1n))), dq: url(hex(D % (Q - 1n))), qi: url(hex(inv(Q, P))) }, format: 'jwk' })
  } else if (/^ecdsa-sha2-nistp(256|384|521)$/u.test(type)) {
    const curve = p.string().toString(), point = p.string(), d = p.string(), size = (point.length - 1) / 2
    key = createPrivateKey({ key: { kty: 'EC', crv: { nistp256: 'P-256', nistp384: 'P-384', nistp521: 'P-521' }[curve], x: point.subarray(1, 1 + size).toString('base64url'), y: point.subarray(1 + size).toString('base64url'), d: url(d) }, format: 'jwk' })
  } else throw refuse()
  return { type, publicBlob, key }
}

export const sshIdentity = fields => { if (!fields?.ssh_key) throw refuse(); return parseOpenSshKey(fields.ssh_key).publicBlob.toString('base64') }

// flags as in the agent protocol: 2 = rsa-sha2-256, 4 = rsa-sha2-512 (the old sha1 ssh-rsa is refused).
export function sshSign(fields, data, flags = 0) {
  if (!fields?.ssh_key || typeof data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data) || data.length > 8192) throw refuse()
  const input = Buffer.from(data, 'base64'), { type, key } = parseOpenSshKey(fields.ssh_key)
  if (type === 'ssh-ed25519') return Buffer.concat([str('ssh-ed25519'), str(sign(null, input, key))]).toString('base64')
  if (type === 'ssh-rsa') {
    const alg = flags & 4 ? ['rsa-sha2-512', 'sha512'] : flags & 2 ? ['rsa-sha2-256', 'sha256'] : null
    if (!alg) throw refuse()
    return Buffer.concat([str(alg[0]), str(sign(alg[1], input, key))]).toString('base64')
  }
  const bits = type.slice(-3), hash = { 256: 'sha256', 384: 'sha384', 521: 'sha512' }[bits], size = { 256: 32, 384: 48, 521: 66 }[bits]
  const raw = sign(hash, input, { key, dsaEncoding: 'ieee-p1363' })
  return Buffer.concat([str(type), str(Buffer.concat([mpint(raw.subarray(0, size)), mpint(raw.subarray(size))]))]).toString('base64')
}
