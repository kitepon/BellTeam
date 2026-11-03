import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { composeProjectInstructions } from './project-instructions.mjs'

const exec = promisify(execFile)
const maximum = 16 * 1024 * 1024
const fail = () => { throw Object.assign(new Error('MEMBERS_PROJECT_INVALID'), { code: 'MEMBERS_PROJECT_INVALID' }) }
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === names.split(',').filter(Boolean).sort().join(',')
const text = value => typeof value === 'string' && Buffer.byteLength(value) <= maximum
const bot = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value)

export function validateMembersProjectRequest(operation, params) {
  const fields = {
    'project.ensureRoot': '', 'project.claim': 'botId', 'project.initialize': 'botId',
    'project.remove': 'botId', 'project.readPreviousSession': 'botId',
    'project.writeInstructions': 'botId,body',
    'project.prepareStartupContext': 'botId,body,previousSession',
    'project.appendInstructions': 'botId,text', 'global.writeInstructions': 'body',
  }
  if (!Object.hasOwn(fields, operation) || !exact(params, fields[operation])) fail()
  if (Object.hasOwn(params, 'botId') && !bot(params.botId)) fail()
  for (const name of ['body', 'previousSession', 'text'])
    if (Object.hasOwn(params, name) && !text(params[name])) fail()
}

async function directory(path, create = false) {
  if (create) await mkdir(path, { recursive: true })
  const info = await lstat(path)
  if (!info.isDirectory() || info.uid !== process.getuid() || await realpath(path) !== path) fail()
}

async function file(path, body, mode, append = false) {
  const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW
    | (append ? constants.O_APPEND : 0), mode)
  try {
    const info = await fd.stat()
    if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1) fail()
    if (!append) await fd.truncate(0)
    await fd.writeFile(body)
    await fd.chmod(mode)
  } finally { await fd.close() }
}

// The parent supplies root/home from its fixed SeatRuntime, never from the members DTO.
export async function operateMembersProject({ root, home }, operation, params) {
  validateMembersProjectRequest(operation, params)
  const botsRoot = join(root, 'bots')
  if (operation === 'global.writeInstructions') {
    await directory(home)
    for (const cli of ['.claude', '.codex', '.grok', '.cursor', '.gemini']) {
      const target = join(home, cli)
      await directory(target)
      await file(join(target, 'AGENTS.md'), params.body, 0o600)
      if (cli === '.claude') await file(join(target, 'CLAUDE.md'), '@AGENTS.md\n', 0o600)
    }
    return null
  }
  if (operation === 'project.ensureRoot') { await directory(botsRoot, true); return null }
  await directory(botsRoot)
  const project = join(botsRoot, params.botId)
  if (operation === 'project.claim') {
    try { await mkdir(project) } catch (error) {
      if (error.code === 'EEXIST') throw Object.assign(new Error('BOT_PROJECT_EXISTS'), { code: 'BOT_PROJECT_EXISTS' })
      throw error
    }
    return null
  }
  try { await directory(project) } catch (error) {
    if (operation === 'project.remove' && error.code === 'ENOENT') return null
    if (operation !== 'project.initialize' || error.code !== 'ENOENT') throw error
    await directory(project, true)
  }
  if (operation === 'project.remove') { await rm(project, { recursive: true, force: true }); return null }
  if (operation === 'project.initialize') {
    for (const target of ['docs', 'environment', 'assets', 'assets/character-sheet']) await directory(join(project, target), true)
    try {
      if ((await lstat(join(project, '.git'))).isSymbolicLink()) fail()
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await exec('git', ['init', '-q'], { cwd: project })
    }
    return null
  }
  if (operation === 'project.readPreviousSession') {
    let fd
    try {
      await directory(join(project, 'memory'))
      fd = await open(join(project, 'memory/previous-session.md'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const info = await fd.stat()
      if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || info.size > maximum) fail()
      const buffer = Buffer.alloc(info.size + 1)
      let size = 0
      while (size < buffer.length) {
        const result = await fd.read(buffer, size, buffer.length - size, size)
        if (!result.bytesRead) break
        size += result.bytesRead
      }
      const after = await fd.stat()
      if (size !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) fail()
      return buffer.subarray(0, size).toString('utf8')
    } catch (error) { if (error.code === 'ENOENT') return ''; throw error }
    finally { await fd?.close() }
  }
  if (operation === 'project.prepareStartupContext') {
    await directory(join(project, 'memory'), true)
    await file(join(project, 'memory/previous-session.md'), `${params.previousSession.trim()}\n`, 0o600)
  }
  if (operation === 'project.appendInstructions') await file(join(project, 'AGENTS.md'), params.text, 0o644, true)
  else {
    const body = await composeProjectInstructions(project, params.body)
    await file(join(project, 'AGENTS.md'), body, 0o644)
    await file(join(project, 'CLAUDE.md'), '@AGENTS.md\n', 0o644)
  }
  return null
}
