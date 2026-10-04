// RTK（担当ドリリー）の各ハーネスのhookを、BellTeamコンテナの共有設定へ登録する。
// 登録の仕様はドリリーの docs/rtk-bellteam-registration.md（RTK v0.50.0）に従う。
// BellTeamが足すのはRTKの項目だけで、他のhookの位置と中身は変えない。
// 本家の `rtk init` は、Codex・Cursorでは指示ファイル（AGENTS.md）へ追記し、BellTeamが生成し直す
// ファイルとぶつかるため、Claude以外は項目を直接書く。
import { spawn } from 'node:child_process'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeEnvironment } from './runtime-home.mjs'

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)))
export const RTK_BIN = '/usr/local/bin/rtk'
export const CODEX_RTK_COMMAND = 'rtk hook codex'
export const CURSOR_RTK_COMMAND = 'rtk hook cursor'

export async function configureRtk(home, { run, withCodexAppServer = codexAppServer } = {}) {
  const env = { ...runtimeEnvironment(process.env, home), RTK_TELEMETRY_DISABLED: '1' }
  await run('rtk', ['init', '-g', '--hook-only', '--auto-patch', '--no-trust-filters'], { env })
  const codexHooks = join(home, '.codex/hooks.json')
  await updateJson(codexHooks, addCodexHook)
  await trustCodexHook(home, codexHooks, withCodexAppServer, env)
  await updateJson(join(home, '.cursor/hooks.json'), addCursorHook)
  await writeGrokHook(home)
}

export function addCodexHook(current) {
  const hooks = objectField(current, 'hooks', 'Codex')
  const groups = arrayField(hooks, 'PreToolUse', 'Codex')
  if (groups.some(group => group?.hooks?.some(hook => hook?.command === CODEX_RTK_COMMAND))) return current
  return { ...current, hooks: { ...hooks, PreToolUse: [...groups, {
    matcher: 'Bash', hooks: [{ type: 'command', command: CODEX_RTK_COMMAND }],
  }] } }
}

export function addCursorHook(current) {
  const hooks = objectField(current, 'hooks', 'Cursor')
  const entries = arrayField(hooks, 'preToolUse', 'Cursor')
  if (entries.some(entry => entry?.command === CURSOR_RTK_COMMAND)) return current
  return { version: 1, ...current, hooks: { ...hooks, preToolUse: [...entries, { command: CURSOR_RTK_COMMAND, matcher: 'Shell' }] } }
}

export function grokHookConfig(root = appRoot) {
  return { hooks: { PreToolUse: [{ matcher: '^run_terminal_command$', hooks: [{
    type: 'command', command: `node ${join(root, 'integrations/rtk/grok-hook.mjs')}`, timeout: 5, env: { RTK_BIN },
  }] }] } }
}

// Codexは、新しいhookを現在の定義に対する信頼記録があるまで動かさない。公式App Serverの
// hooks/list が示す鍵とhashで、RTKのhandlerだけを信頼し、他のhandlerの信頼は変えない。
export async function trustCodexHook(home, hooksFile, withCodexAppServer, env) {
  const source = await realpath(hooksFile)
  await withCodexAppServer(env, async request => {
    const list = async () => ((await request('hooks/list', { cwds: [join(home, '.codex')] }))?.data?.[0]?.hooks ?? [])
      .filter(hook => hook.command === CODEX_RTK_COMMAND && hook.sourcePath === source)
    const owned = await list()
    if (!owned.length) throw new Error('RTK_CODEX_HOOK_NOT_LISTED')
    const edits = owned.filter(hook => !hook.enabled || hook.trustStatus !== 'trusted').flatMap(hook => {
      if (typeof hook.key !== 'string' || typeof hook.currentHash !== 'string') throw new Error('RTK_CODEX_HOOK_SCHEMA_UNKNOWN')
      const key = `hooks.state.${JSON.stringify(hook.key)}`
      return [
        { keyPath: `${key}.trusted_hash`, value: hook.currentHash, mergeStrategy: 'replace' },
        { keyPath: `${key}.enabled`, value: true, mergeStrategy: 'replace' },
      ]
    })
    if (!edits.length) return
    await request('config/batchWrite', { edits, filePath: join(home, '.codex/config.toml') })
    if ((await list()).some(hook => !hook.enabled || hook.trustStatus !== 'trusted')) throw new Error('RTK_CODEX_HOOK_NOT_TRUSTED')
  })
}

async function writeGrokHook(home) {
  const path = join(home, '.grok/hooks/rtk.json')
  await mkdir(dirname(path), { recursive: true })
  const next = `${JSON.stringify(grokHookConfig(), null, 2)}\n`
  let current = null
  try { current = await readFile(path, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (current !== next) await writeFile(path, next, { mode: 0o600 })
}

async function updateJson(path, update) {
  let text = null
  try { text = await readFile(path, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
  let current = {}
  if (text !== null) {
    try { current = JSON.parse(text.replace(/^﻿/u, '')) } catch { throw new Error(`RTK_HOOK_CONFIG_INVALID: ${path}`) }
  }
  const next = update(current)
  if (text !== null && next === current) return
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
}

function objectField(value, name, harness) {
  const object = item => item && typeof item === 'object' && !Array.isArray(item)
  if (!object(value) || (value[name] !== undefined && !object(value[name]))) throw new Error(`RTK_HOOK_CONFIG_INVALID: ${harness}`)
  return value[name] ?? {}
}

function arrayField(value, name, harness) {
  if (value[name] !== undefined && !Array.isArray(value[name])) throw new Error(`RTK_HOOK_CONFIG_INVALID: ${harness}`)
  return value[name] ?? []
}

// 公式App Server（`codex app-server`）へstdioでつなぎ、threadもturnも作らずに設定だけを扱う。
async function codexAppServer(env, use) {
  const child = spawn('codex', ['app-server', '--listen', 'stdio://'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = ''
  let stderr = ''
  let nextId = 0
  const waiting = new Map()
  const fail = error => { for (const { reject } of waiting.values()) reject(error); waiting.clear() }
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000) })
  child.on('error', fail)
  child.on('exit', code => fail(new Error(`CODEX_APP_SERVER_EXITED: ${code} ${stderr.trim()}`)))
  child.stdout.on('data', data => {
    buffer += data
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      let message
      try { message = JSON.parse(line) } catch { continue }
      const pending = waiting.get(message.id)
      if (!pending) continue
      waiting.delete(message.id)
      if (message.error) pending.reject(new Error(`CODEX_APP_SERVER_ERROR: ${JSON.stringify(message.error)}`))
      else pending.resolve(message.result)
    }
  })
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId
    waiting.set(id, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  })
  try {
    await request('initialize', { clientInfo: { name: 'bellteam', version: '1' }, capabilities: { experimentalApi: true } })
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
    return await use(request)
  } finally {
    child.kill()
  }
}
