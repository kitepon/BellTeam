import { constants } from 'node:fs'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/u
const ASSET_FILE = /^([a-z0-9][a-z0-9-]{0,127})\.(png|jpg|webp|gif)$/u
const MAX_IMAGE_BYTES = 25 * 1024 * 1024

const MIME_EXTENSION = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
])
const EXTENSION_MIME = new Map([...MIME_EXTENSION].map(([mime, extension]) => [extension, mime]))

export class MessageAssets {
  constructor({ root, maxBytes = MAX_IMAGE_BYTES }) {
    this.root = root
    this.maxBytes = maxBytes
  }

  async save({ owner, id, image }) {
    validateId(owner)
    validateId(id)
    const bytes = await imageBytes(image, this.maxBytes)
    const mime = detectMime(bytes)
    if (!mime) throw new Error('IMAGE_FILE_INVALID')
    const extension = MIME_EXTENSION.get(mime)
    const file = `${id}.${extension}`
    const directory = this.directory(owner)
    await mkdir(directory, { recursive: true })
    try {
      await writeFile(join(directory, file), bytes, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('IMAGE_ASSET_DUPLICATE')
      throw error
    }
    return Object.freeze({ owner, file, mime })
  }

  async open(owner, file) {
    validateId(owner)
    const match = String(file).match(ASSET_FILE)
    if (!match) throw new Error('IMAGE_ASSET_INVALID')
    const mime = EXTENSION_MIME.get(match[2])
    let handle
    try {
      handle = await open(join(this.directory(owner), file), constants.O_RDONLY | constants.O_NOFOLLOW)
      const info = await handle.stat()
      if (!info.isFile() || info.size > this.maxBytes) throw new Error('IMAGE_ASSET_INVALID')
      return { mime, size: info.size, stream: handle.createReadStream() }
    } catch (error) {
      await handle?.close().catch(() => {})
      if (error.code === 'ENOENT') throw new Error('IMAGE_ASSET_NOT_FOUND')
      if (error.code === 'ELOOP') throw new Error('IMAGE_ASSET_INVALID')
      throw error
    }
  }

  // オーナーが送った画像は、Botのプロジェクトではなくオーナーの場所に置く。
  async saveAll({ owner, id, images }) {
    const saved = []
    for (const [index, image] of images.entries()) saved.push(await this.save({ owner, id: `${id}-${index + 1}`, image }))
    return saved
  }

  directory(owner) {
    if (owner === 'user') return join(this.root, 'owner', 'messages', 'assets')
    return join(this.root, 'bots', owner, 'messages', 'assets')
  }
}

async function imageBytes(image, maxBytes) {
  if (typeof image?.path === 'string' && image.path.length > 0) {
    let handle
    try {
      handle = await open(image.path, constants.O_RDONLY | constants.O_NOFOLLOW)
      const info = await handle.stat()
      if (!info.isFile()) throw new Error('IMAGE_FILE_INVALID')
      if (info.size > maxBytes) throw new Error('IMAGE_FILE_TOO_LARGE')
      return await handle.readFile()
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('IMAGE_FILE_NOT_FOUND')
      if (error.code === 'ELOOP') throw new Error('IMAGE_FILE_INVALID')
      throw error
    } finally {
      await handle?.close().catch(() => {})
    }
  }
  if (typeof image?.data === 'string' && /^[a-z0-9+/=]+$/iu.test(image.data)) {
    const bytes = Buffer.from(image.data, 'base64')
    if (bytes.length > maxBytes) throw new Error('IMAGE_FILE_TOO_LARGE')
    return bytes
  }
  throw new Error('IMAGE_FILE_INVALID')
}

function detectMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

function validateId(value) {
  if (!SAFE_ID.test(String(value))) throw new Error('IMAGE_ASSET_INVALID')
}
