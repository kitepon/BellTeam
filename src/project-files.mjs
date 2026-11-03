// Project files belong to the seat. Registry state is persisted separately.
import { execFile } from 'node:child_process'
import { access, appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { CHARACTER_SHEET_DIRECTORY } from './character-sheets.mjs'

import { renderBotInstructions } from './members/instructions.mjs'

const exec = promisify(execFile)

export class ProjectFiles {
  async ensureRoot(root) { await mkdir(root, { recursive: true }) }

  async claim(project) {
    try { await mkdir(project) } catch (error) {
      if (error.code === 'EEXIST') throw Object.assign(new Error('BOT_PROJECT_EXISTS'), { code: 'BOT_PROJECT_EXISTS' })
      throw error
    }
  }

  async initialize(project) {
    await ensureProjectFolders(project)
    await ensureGitProject(project)
  }

  async remove(project) { await rm(project, { recursive: true, force: true }) }

  async writeInstructions(profile) {
    const memoryPath = join(profile.project, 'memory', 'previous-session.md')
    const shortTermMemory = await exists(memoryPath) ? (await readFile(memoryPath, 'utf8')).trim() : ''
    const body = renderBotInstructions(profile, shortTermMemory)
    await Promise.all([
      writeFile(join(profile.project, 'AGENTS.md'), body, { mode: 0o644 }),
      writeFile(join(profile.project, 'CLAUDE.md'), '@AGENTS.md\n', { mode: 0o644 }),
    ])
  }


  async prepareStartupContext(profile, shortTermMemory) {
    const directory = join(profile.project, 'memory')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'previous-session.md'), `${shortTermMemory.trim()}\n`, { mode: 0o600 })
    await this.writeInstructions(profile)
  }

  async appendInstructions(profile, text) {
    await appendFile(join(profile.project, 'AGENTS.md'), text)
  }
}

async function exists(path) {
  try { await readFile(path); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

// Botプロジェクトの固定フォルダ: 手順書のdocs/、環境構築のenvironment/、キャラクターシート（設定画）のassets/character-sheet/。
async function ensureProjectFolders(project) {
  for (const folder of ['docs', 'environment', CHARACTER_SHEET_DIRECTORY]) await mkdir(join(project, folder), { recursive: true })
}

async function ensureGitProject(project) {
  try {
    await access(join(project, '.git'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await exec('git', ['init', '-q'], { cwd: project })
  }
}
