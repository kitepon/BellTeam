import { constants } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

// キャラクターシート（設定画）: オーナーが決めた、Botが自分を描く時の正本。Botプロジェクトのassets/character-sheet/直下の画像だけを扱い、下書き用のサブフォルダは見せない。
export const CHARACTER_SHEET_DIRECTORY = 'assets/character-sheet'

const SHEET_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(png|jpe?g|webp|gif)$/iu
const EXTENSION_MIME = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
])

export class CharacterSheets {
  constructor({ projectPath }) {
    this.projectPath = projectPath
  }

  directory(botId) {
    return join(this.projectPath(botId), CHARACTER_SHEET_DIRECTORY)
  }

  async list(botId) {
    const directory = this.directory(botId)
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    const sheets = []
    for (const entry of entries) {
      if (!entry.isFile() || !SHEET_FILE.test(entry.name)) continue
      const info = await stat(join(directory, entry.name))
      sheets.push({ file: entry.name, size: info.size, updatedAt: info.mtime.toISOString() })
    }
    return sheets.sort((a, b) => a.file.localeCompare(b.file))
  }

  async open(botId, file) {
    const match = String(file).match(SHEET_FILE)
    if (!match) throw new Error('CHARACTER_SHEET_INVALID')
    const mime = EXTENSION_MIME.get(match[1].toLowerCase())
    let handle
    try {
      handle = await open(join(this.directory(botId), file), constants.O_RDONLY | constants.O_NOFOLLOW)
      const info = await handle.stat()
      if (!info.isFile()) throw new Error('CHARACTER_SHEET_INVALID')
      return { mime, size: info.size, stream: handle.createReadStream() }
    } catch (error) {
      await handle?.close().catch(() => {})
      if (error.code === 'ENOENT') throw new Error('CHARACTER_SHEET_NOT_FOUND')
      throw error
    }
  }
}
