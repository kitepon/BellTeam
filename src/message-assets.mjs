import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
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
  #removals = new Map()
  #saves = new Map()
  #ready
  #restored

  constructor({ root, maxBytes = MAX_IMAGE_BYTES, botsAssetsRoot = join(root, 'bots'), readImage = readImageBytes, readRemovalStates = null, saveAdmission = null }) {
    if (saveAdmission && (readRemovalStates !== null || typeof saveAdmission.beginSave !== 'function'
      || typeof saveAdmission.endSave !== 'function')) throw new Error('IMAGE_ASSET_ADMISSION_INVALID')
    this.root = root
    this.maxBytes = maxBytes
    this.botsAssetsRoot = botsAssetsRoot
    this.readImage = readImage
    this.saveAdmission = saveAdmission
    this.#restored = readRemovalStates === null
    this.#ready = readRemovalStates === null ? Promise.resolve() : Promise.resolve().then(async () => {
      const state = await readRemovalStates()
      if (!Array.isArray(state?.removals)) throw new Error('IMAGE_REMOVAL_STATE_INVALID')
      const ids = new Set()
      for (const removal of state.removals) {
        validateBotId(removal?.botId)
        if (ids.has(removal.botId) || typeof removal.active !== 'boolean' || removal.hasIntent !== true
          || typeof removal.retired !== 'boolean' || (removal.active && removal.retired)) throw new Error('IMAGE_REMOVAL_STATE_INVALID')
        ids.add(removal.botId)
      }
      for (const id of ids) this.#closeBot(id)
      this.#restored = true
    })
    // 初期案内より先に開始する読取の失敗は、initialize/saveの待ち手へ返す。
    this.#ready.catch(() => {})
  }

  async initialize() {
    await this.#ready
  }

  async save({ owner, id, image }) {
    validateId(owner)
    validateId(id)
    return this.#trackSave(owner, lease => this.#save({ owner, id, image, lease }))
  }

  async #save({ owner, id, image, lease }) {
    const bytes = await this.readImage(image, this.maxBytes, lease)
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
    if (this.saveAdmission) throw new Error('IMAGE_ASSET_READ_PARENT_ONLY')
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
    validateId(owner)
    return this.#trackSave(owner, async lease => {
      const saved = []
      for (const [index, image] of images.entries()) {
        const imageId = `${id}-${index + 1}`
        validateId(imageId)
        saved.push(await this.#save({ owner, id: imageId, image, lease }))
      }
      return saved
    })
  }

  async #trackSave(owner, save) {
    let lease
    if (this.saveAdmission) {
      lease = await this.saveAdmission.beginSave(owner)
      if (typeof lease !== 'string' || !lease) throw new Error('IMAGE_ASSET_ADMISSION_INVALID')
    }
    if (owner !== 'user' && !this.#restored) await this.#ready
    if (owner !== 'user' && this.#removals.has(owner)) throw new Error('IMAGE_BOT_REMOVAL_PENDING')
    let finish
    const pending = new Promise(resolve => { finish = resolve })
    const saves = this.#saves.get(owner) ?? new Set()
    this.#saves.set(owner, saves)
    saves.add(pending)
    let failure
    try { return await save(lease) }
    catch (error) { failure = error; throw error }
    finally {
      saves.delete(pending)
      if (!saves.size) this.#saves.delete(owner)
      finish()
      if (this.saveAdmission) {
        try { await this.saveAdmission.endSave(lease) }
        catch (error) {
          if (failure) throw new AggregateError([failure, error], 'IMAGE_ASSET_SAVE_AND_RELEASE_FAILED')
          throw error
        }
      }
    }
  }

  #closeBot(botId) {
    if (!this.#removals.has(botId)) this.#removals.set(botId, {
      lease: randomUUID(), drained: Promise.all([...(this.#saves.get(botId) ?? [])]),
    })
    return this.#removals.get(botId)
  }

  async prepareBotAssetRemoval(botId) {
    if (this.saveAdmission) throw new Error('IMAGE_ASSET_GATE_PARENT_ONLY')
    validateBotId(botId)
    const gate = this.#closeBot(botId)
    await this.#ready
    await gate.drained
    return gate.lease
  }

  cancelBotAssetRemoval(botId, lease, state) {
    if (this.saveAdmission) throw new Error('IMAGE_ASSET_GATE_PARENT_ONLY')
    validateBotId(botId)
    const gate = this.#removals.get(botId)
    if (!this.#restored || !gate || typeof lease !== 'string' || gate.lease !== lease
      || state?.active !== true || state?.hasIntent !== false || state?.retired !== false) return false
    this.#removals.delete(botId)
    return true
  }

  directory(owner) {
    if (owner === 'user') return join(this.root, 'owner', 'messages', 'assets')
    return join(this.botsAssetsRoot, owner, 'messages', 'assets')
  }
}

export async function readImageBytes(image, maxBytes = MAX_IMAGE_BYTES) {
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

function validateBotId(value) {
  if (typeof value !== 'string' || value === 'user') throw new Error('IMAGE_ASSET_INVALID')
  validateId(value)
}
