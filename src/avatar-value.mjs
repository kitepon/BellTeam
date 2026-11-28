import { createHash } from 'node:crypto'

export function validateAvatar(value, code = 'BOT_AVATAR_INVALID') {
  if (typeof value !== 'string' || value.length > 3_000_000) throw new Error(code)
  if (value === '') return
  if (/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/iu.test(value)) return
  throw new Error(code)
}

// shortcut: counted in entries, not bytes (live strings are shared with the profile cache); raise it when a roster passes ~1000 bots.
const AVATAR_VERSION_LIMIT = 4096
const avatarVersions = new Map()

// アバターはdata URLで保存している。版は中身から決め、アプリは版が変わった時だけ画像を取り直す。
export function avatarVersion(avatar) {
  if (typeof avatar !== 'string' || !avatar) return ''
  let version = avatarVersions.get(avatar)
  if (!version) {
    // Oldest first, never clear(): a roster of 144 bots holds ~576 avatar strings, and a cache emptied every 256 inserts re-hashed ~1 MB each on every snapshot (members module 23% CPU, 2026-11-26).
    if (avatarVersions.size >= AVATAR_VERSION_LIMIT) avatarVersions.delete(avatarVersions.keys().next().value)
    version = createHash('sha256').update(avatar).digest('hex').slice(0, 16)
    avatarVersions.set(avatar, version)
  }
  return version
}

