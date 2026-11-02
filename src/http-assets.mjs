import { webAssetFiles, versionedWebAssets } from '../web/assets.mjs'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { json } from './http-response.mjs'

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.webmanifest', 'application/manifest+json'],
])

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

export async function staticFile(response, root, pathname, assetVersion, { files = webAssetFiles, versioned = versionedWebAssets } = {}) {
  if (!root) return json(response, 404, { error: 'NOT_FOUND' })
  const name = files.get(pathname)
  if (!name) return json(response, 404, { error: 'NOT_FOUND' })
  const file = join(root, name)
  const info = await stat(file)
  if (versioned.has(name)) {
    const body = (await readFile(file, 'utf8')).replaceAll('__ASSET_VERSION__', assetVersion)
    response.writeHead(200, {
      'content-type': contentTypes.get(extname(file)),
      'content-length': Buffer.byteLength(body),
      'cache-control': name === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    })
    return response.end(body)
  }
  response.writeHead(200, {
    'content-type': contentTypes.get(extname(file)) ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'public, max-age=31536000, immutable',
  })
  createReadStream(file).pipe(response)
}
