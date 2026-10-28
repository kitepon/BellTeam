// Project files belong to the seat. Registry state is persisted separately.
import { execFile } from 'node:child_process'
import { access, appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { CHARACTER_SHEET_DIRECTORY } from './character-sheets.mjs'

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
    const body = `# 自分のBot情報\n\nあなたのBellTeam Bot IDは \`${profile.id}\` である。\n\n## 名前\n\n「${profile.name}」\n\n## プロフィール\n\n「${profile.profileText || '指定なし'}」\n\n## 性格（考え方）\n\n「${profile.personality || '指定なし'}」\n\n## 口調\n\n「${profile.speechStyle || '指定なし'}」\n\n## 役職\n\n「${profile.position || '指定なし'}」\n\n## 役割\n\n「${profile.role || '指定なし'}」\n\n# 作業手順\n\n上の役割は、あなた自身が責任を持って進める担当の仕事である。役割欄は担当を短く記し、具体的な作業手順はここへ混ぜない。作業手順の詳細はこのプロジェクトの \`docs/\` に自分で置き、着手前に読む。\n\n# 前セッションの短期記憶\n\n${shortTermMemory || 'なし'}\n`
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
