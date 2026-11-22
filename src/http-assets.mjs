import { avatarVersion } from './avatar-value.mjs'
export { avatarVersion } from './avatar-value.mjs'
import { json } from './http-response.mjs'

// 一覧の `?avatar=omit` は画像本体を外す。指定の無い古いアプリには今までどおり本体を返す。
export function listAvatar(avatar, url) {
  const value = typeof avatar === 'string' ? avatar : ''
  return { avatar: url.searchParams.get('avatar') === 'omit' ? '' : value, avatarVersion: avatarVersion(value) }
}

export function sendAvatar(request, response, avatar, url) {
  const match = typeof avatar === 'string' ? avatar.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/u) : null
  if (!match) return json(response, 404, { error: 'AVATAR_NOT_FOUND' })
  const version = avatarVersion(avatar)
  const headers = {
    etag: `"${version}"`,
    // 版つきURLの中身は変わらない。版の無い取得は毎回確かめさせる。
    'cache-control': url.searchParams.get('v') === version ? 'private, max-age=31536000, immutable' : 'private, no-cache',
  }
  if (request.headers['if-none-match'] === headers.etag) {
    response.writeHead(304, headers)
    return response.end()
  }
  const body = Buffer.from(match[2], 'base64')
  response.writeHead(200, { ...headers, 'content-type': match[1], 'content-length': body.length })
  response.end(body)
}
