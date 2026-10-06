import { execFile, spawn } from 'node:child_process'
import { access, mkdir, open, realpath, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { runtimeEnvironment } from './runtime-home.mjs'

const exec = promisify(execFile)
const root = process.env.BELLTEAM_ROOT ?? '/srv/bellteam'
// GitHubの認証とgit設定は全Botで共有する（オーナー裁定 2026-09-25）。HOMEは再設置で作り直すので永続領域を指す。
const github = join(root, 'shared/tools/github')

export function baseBotEnvironment(project, inherited = process.env) {
  return {
    ...runtimeEnvironment(inherited),
    BELLTEAM_PROJECT: project,
    PATH: [join(project, '.local/bin'), join(project, 'node_modules/.bin'), inherited.PATH].filter(Boolean).join(':'),
    npm_config_prefix: join(project, '.local'),
    npm_config_cache: join(project, '.cache/npm'),
    PIP_CACHE_DIR: join(project, '.cache/pip'),
    GH_CONFIG_DIR: join(github, 'gh'),
    GIT_CONFIG_GLOBAL: join(github, 'gitconfig'),
    // Claude Codeは自分を更新する時に `npm install -g` を流す。席のnpmの導入先は席の `.local` なので、
    // 席ごとに写しが出来て、席はコンテナの物ではなく写しを使い続ける（2026-10-06、18席に4つの版）。
    // 席では更新させず、全席がコンテナの物を使う。版は、ほかのCLIと同じく反映の時に変わる（オーナーの指摘 2026-10-06「共通化しなかった？」）。
    DISABLE_AUTOUPDATER: '1',
  }
}

// 席の `.local` に出来たClaude Codeの写しを片付ける（コンテナ起動ごとに一度、setup.shより前）。
// 消すのはCLIの写しと、それを指す入口だけ。席のほかの物には触らない。
// setup.shが自分で入れ直す席は、その席の版を使い続ける。一席の失敗で起動を止めない。
export async function removeSeatClaudeCopies(bots, { report = message => process.stderr.write(`${message}\n`) } = {}) {
  const removed = []
  for (const bot of bots.values()) {
    const prefix = join(bot.project, '.local')
    const copy = join(prefix, 'lib/node_modules/@anthropic-ai/claude-code')
    try {
      if (!await exists(copy)) continue
      const entry = join(prefix, 'bin/claude')
      if (await exists(entry) && (await realpath(entry)).startsWith(`${await realpath(copy)}/`)) await rm(entry)
      await rm(copy, { recursive: true })
      await rmdir(join(prefix, 'lib/node_modules/@anthropic-ai')).catch(error => {
        if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error
      })
      removed.push(bot.id)
      report(`BellTeam environment ${bot.id}: 席のClaude Codeの写しを片付けました`)
    } catch (error) {
      report(`BellTeam environment ${bot.id}: 席のClaude Codeの写しを片付けられませんでした（${error.message}）`)
    }
  }
  return removed
}

// env.shはBot自身が所有するシェル設定。値をツール引数やログへ出さない。
export async function loadBotEnvironment(project, inherited = process.env) {
  const env = baseBotEnvironment(project, inherited)
  const path = join(project, 'environment/env.sh')
  if (!await exists(path)) return env
  const { stdout } = await exec('bash', ['--noprofile', '--norc', '-c',
    'set -ae\n. "$1" >&2\nexec "$2" -e \'process.stdout.write(JSON.stringify(process.env))\'',
    'bellteam-environment', path, process.execPath,
  ], { cwd: project, env })
  return runtimeEnvironment(JSON.parse(stdout), env.BELLTEAM_HOME)
}

// コンテナ起動ごとに一度、順番に復元する。aptなどの共有インストーラを並走させない。
// 一席の失敗で全員の会話を止めない。本人がログを読んで修正し、同じスクリプトを手動実行する。
export async function restoreBotEnvironments(bots, { report = message => process.stderr.write(`${message}\n`) } = {}) {
  const results = []
  for (const bot of bots.values()) {
    const directory = join(bot.project, 'environment')
    await mkdir(directory, { recursive: true })
    const script = join(directory, 'setup.sh')
    if (!await exists(script)) continue
    const log = await open(join(directory, 'setup.log'), 'w', 0o600)
    let code
    try {
      await log.write(`[${new Date().toISOString()}] ${script}\n`)
      code = await new Promise((resolve, reject) => {
        const child = spawn('bash', ['--noprofile', '--norc', '-e', script], {
          cwd: bot.project, env: baseBotEnvironment(bot.project),
          stdio: ['ignore', log.fd, log.fd],
        })
        child.once('error', reject)
        child.once('close', value => resolve(value))
      })
      await log.write(`\n終了コード: ${code}\n`)
    } catch (error) {
      code = null
      await log.write(`\n${error.message}\n`)
    } finally {
      await log.close()
    }
    results.push({ botId: bot.id, code })
    report(`BellTeam environment ${bot.id}: ${code === 0 ? 'restored' : `failed (${code}); ${join(directory, 'setup.log')}`}`)
  }
  return results
}

async function exists(path) {
  try { await access(path); return true }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
