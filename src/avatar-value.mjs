import { createHash } from 'node:crypto'

export function validateAvatar(value, code = 'BOT_AVATAR_INVALID') {
  if (typeof value !== 'string' || value.length > 3_000_000) throw new Error(code)
  if (value === '') return
  if (/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/iu.test(value)) return
  throw new Error(code)
}

const avatarVersions = new Map()

// アバターはdata URLで保存している。版は中身から決め、アプリは版が変わった時だけ画像を取り直す。
export function avatarVersion(avatar) {
  if (typeof avatar !== 'string' || !avatar) return ''
  let version = avatarVersions.get(avatar)
  if (!version) {
    if (avatarVersions.size >= 256) avatarVersions.clear()
    version = createHash('sha256').update(avatar).digest('hex').slice(0, 16)
    avatarVersions.set(avatar, version)
  }
  return version
}

