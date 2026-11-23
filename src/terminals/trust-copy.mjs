// a532b4 stage 2 (terminals README "Stage 2"): the public host trust of one terminal as Aiterm's `aiterm-remote export --ref R`
// says it. Public lines only; this module reads nothing of Aiterm's files and holds no key, handle or key path.
export const EXPORT_SCHEMA = 'aiterm.remote-binding-export.v1'
// `<host pattern> <key type> <base64>`: a known_hosts line, never a private key (those do not fit this shape).
const LINE = /^\S{1,300} (?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]{20,1500}={0,2}$/
const REVISION = /^sha256:[0-9a-f]{64}$/
const invalid = () => Object.assign(new Error('TRUST_EXPORT_INVALID'), { code: 'TRUST_EXPORT_INVALID' })

// The stored form of `terminal.trustCopy`, or a thrown TRUST_EXPORT_INVALID: nothing is stored from an answer that does not fit.
export function parseExport(value, ref, copiedAt) {
  const object = value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!object || value.schema !== EXPORT_SCHEMA || value.ref !== ref) throw invalid()
  const { known_hosts_lines: lines, host_key_alias: alias, fingerprints, trust_revision: revision } = value
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > 8 || !lines.every(line => typeof line === 'string' && LINE.test(line))) throw invalid()
  if (alias !== null && alias !== undefined && (typeof alias !== 'string' || alias.length > 253 || /\s/.test(alias))) throw invalid()
  if (!Array.isArray(fingerprints) || fingerprints.length > 8 || !fingerprints.every(item => typeof item === 'string' && item.length <= 100 && !/\s/.test(item))) throw invalid()
  if (typeof revision !== 'string' || !REVISION.test(revision)) throw invalid()
  return { ref, alias: alias ?? null, lines: [...lines], fingerprints: [...fingerprints], revision, copiedAt }
}

// The same shape check for what the registry stores, so a damaged store is refused on read like every other field.
export function validTrustCopy(copy) {
  try { parseExport({ schema: EXPORT_SCHEMA, ref: copy.ref, known_hosts_lines: copy.lines, host_key_alias: copy.alias, fingerprints: copy.fingerprints, trust_revision: copy.revision }, copy.ref, copy.copiedAt); return typeof copy.copiedAt === 'string' && copy.copiedAt.length <= 40 } catch { return false }
}
