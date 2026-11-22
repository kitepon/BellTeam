import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { runtimeHome } from './runtime-home.mjs'

// a521: a seat on another terminal keeps its images there, so Aiterm reads them (transport.readSeatImage, image_read); every other image is read on the body.
// Shared by every MessageAssets that saves a seat's image (the parent's direct path, the legacy services, the module child's effect); `owner` is the saving Bot.
export const seatImageReader = ({ bots, transport, local }) => (image, maxBytes, _lease, owner) => {
  const bot = typeof image?.path === 'string' ? bots?.get?.(owner) : null
  if (!(bot?.terminalId && bot?.projectRoot)) return local(image, maxBytes)
  if (typeof transport?.readSeatImage !== 'function') throw new Error('IMAGE_REMOTE_READ_UNAVAILABLE')
  return transport.readSeatImage(bot, image.path, maxBytes)
}

export async function resolveBotImagePath(bot, input, { home = runtimeHome() } = {}) {
  if (typeof input !== 'string' || input.length === 0) throw new Error('IMAGE_PATH_INVALID')
  if (isAbsolute(input)) return input
  const relative = normalize(input)
  if (relative === '..' || relative.startsWith(`..${sep}`)) throw new Error('IMAGE_PATH_INVALID')
  const projectPath = resolve(bot.project, relative)
  if (await regularFile(projectPath)) return projectPath
  if (bot.harness !== 'grok') return projectPath
  // Third-party, unofficial dependency (Owner ruling 2026-11-14): Grok CLI has no contracted interface for its session files; this is BellTeam's only read of ~/.grok/sessions.

  const sessionRoot = join(home, '.grok', 'sessions', encodeURIComponent(bot.project))
  let sessions
  try { sessions = await readdir(sessionRoot, { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return projectPath; throw error }
  const candidates = []
  for (const session of sessions) {
    if (!session.isDirectory()) continue
    const path = join(sessionRoot, session.name, relative)
    try {
      const info = await stat(path)
      if (info.isFile()) candidates.push({ path, modified: info.mtimeMs })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  candidates.sort((a, b) => b.modified - a.modified)
  return candidates[0]?.path ?? projectPath
}

async function regularFile(path) {
  try { return (await stat(path)).isFile() }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
