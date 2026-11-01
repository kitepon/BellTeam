export function validateAvatar(value, code = 'BOT_AVATAR_INVALID') {
  if (typeof value !== 'string' || value.length > 3_000_000) throw new Error(code)
  if (value === '') return
  if (/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/iu.test(value)) return
  throw new Error(code)
}

