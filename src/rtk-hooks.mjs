// RTK（担当ドリリー）の各ハーネスのhookを、BellTeamコンテナの共有設定へ登録する。
// 登録の仕様はドリリーの docs/rtk-bellteam-registration.md（2026-10-13改訂、RTK v0.51.0）に従う。
// BellTeamが足すのはRTKの項目だけで、他のhookの位置と中身は変えない。
// テストの関所（testgate。担当マクスウェル）が共通の置き場にある設置では、同じ項目のcommandを関所にする。
// 関所が中でRTKを呼ぶので項目は増やさない（同じ道具の前のhookは並んで走り、書き換えが2つ返った時の合わせ方が決まっていない）。
// 本家の `rtk init` は使わない。Codex・Cursorでは指示ファイル（AGENTS.md）へ追記し、BellTeamが生成し直す
// ファイルとぶつかる。Claudeでは、関所の項目だけがある設定へRTKを直接呼ぶ項目を足す（RTK 0.51.0で実測）。
import { spawn } from 'node:child_process'
import { access, constants, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeEnvironment } from './runtime-home.mjs'

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)))
export const RTK_BIN = '/usr/local/bin/rtk'
export const CLAUDE_RTK_COMMAND = 'rtk hook claude'
export const CODEX_RTK_COMMAND = 'rtk hook codex'
export const CURSOR_RTK_COMMAND = 'rtk hook cursor'
// 関所の入口。版の差し替えは、マクスウェルが共通の置き場で `current` を付け替えて行う。
export const TESTGATE_ENTRY = '/srv/bellteam/shared/tools/testgate/current/bin/testgate.mjs'

// 関所の実体があればそのpathを返す。無い設置（配布物、コンテナの外での起動など）ではnullを返し、RTKを直接呼ぶ項目を登録する。
export async function testgateEntry({ path = TESTGATE_ENTRY } = {}) {
  try {
    await access(path, constants.R_OK)
    return path
  } catch {
    return null
  }
}

export function testgateCommand(entry, harness) {
  return `node ${entry} hook ${harness}`
}

export async function configureRtk(home, { withCodexAppServer = codexAppServer, testgate = testgateEntry } = {}) {
  const env = runtimeEnvironment(process.env, home)
  const entry = await testgate()
  await updateJson(join(home, '.claude/settings.json'), current => addClaudeHook(current, entry))
  const codexHooks = join(home, '.codex/hooks.json')
  await updateJson(codexHooks, current => addCodexHook(current, entry))
  await trustCodexHook(home, codexHooks, withCodexAppServer, env, ownedCommands('codex', entry).wanted)
  await updateJson(join(home, '.cursor/hooks.json'), current => addCursorHook(current, entry))
  await writeGrokHook(home, entry)
}

export function addClaudeHook(current, entry = null) {
  return setGroupHook(current, 'claude', 'Claude', entry)
}

export function addCodexHook(current, entry = null) {
  return setGroupHook(current, 'codex', 'Codex', entry)
}

export function addCursorHook(current, entry = null) {
  const hooks = objectField(current, 'hooks', 'Cursor')
  const entries = arrayField(hooks, 'preToolUse', 'Cursor')
  const { wanted, owned } = ownedCommands('cursor', entry)
  const found = entries.filter(item => owned.includes(item?.command))
  if (found.length > 1) throw new Error('RTK_HOOK_DUPLICATED: Cursor')
  if (!found.length) return { version: 1, ...current, hooks: { ...hooks, preToolUse: [...entries, { command: wanted, matcher: 'Shell' }] } }
  if (found[0].command === wanted) return current
  return { ...current, hooks: { ...hooks, preToolUse: entries.map(item => item === found[0] ? { ...item, command: wanted } : item) } }
}

// BellTeamが置く項目のcommand。wantedは今回登録する物、ownedはBellTeamの項目として置き換えてよい物（RTKを直接呼ぶ形と関所ごしの形）。
function ownedCommands(harness, entry) {
  const direct = `rtk hook ${harness}`
  const gated = [...new Set([TESTGATE_ENTRY, entry].filter(Boolean))].map(path => testgateCommand(path, harness))
  return { wanted: entry ? testgateCommand(entry, harness) : direct, owned: [direct, ...gated] }
}

// PreToolUseの中でBellTeamの項目を探し、同じ位置でcommandだけを今回の物にする。無ければ末尾へ足す（matcherはBash）。
// 直接呼ぶ形と関所ごしの形が両方残っている設定は、どちらを消すかをここで決めず、登録の失敗にする（仕様：調べてから直す）。
function setGroupHook(current, harness, label, entry) {
  const hooks = objectField(current, 'hooks', label)
  const groups = arrayField(hooks, 'PreToolUse', label)
  const { wanted, owned } = ownedCommands(harness, entry)
  const found = groups.flatMap((group, at) => (Array.isArray(group?.hooks) ? group.hooks : [])
    .filter(hook => owned.includes(hook?.command)).map(hook => ({ at, hook })))
  if (found.length > 1) throw new Error(`RTK_HOOK_DUPLICATED: ${label}`)
  if (!found.length) return { ...current, hooks: { ...hooks, PreToolUse: [...groups, { matcher: 'Bash', hooks: [{ type: 'command', command: wanted }] }] } }
  const [{ at, hook }] = found
  if (hook.command === wanted) return current
  return { ...current, hooks: { ...hooks, PreToolUse: groups.map((group, index) => index !== at ? group
    : { ...group, hooks: group.hooks.map(item => item === hook ? { ...item, command: wanted } : item) }) } }
}

// GrokにはRTK自身のhookが無い。関所が無い設置では同梱のスクリプト、ある設置では関所が `rtk rewrite` を呼ぶ。
export function grokHookConfig(root = appRoot, entry = null) {
  const command = entry ? testgateCommand(entry, 'grok') : `node ${join(root, 'integrations/rtk/grok-hook.mjs')}`
  return { hooks: { PreToolUse: [{ matcher: '^run_terminal_command$', hooks: [{
    type: 'command', command, timeout: 5, env: { RTK_BIN },
  }] }] } }
}

// Codexは、新しいhookを現在の定義に対する信頼記録があるまで動かさない。公式App Serverの
// hooks/list が示す鍵とhashで、RTKのhandlerだけを信頼し、他のhandlerの信頼は変えない。
// 鍵は位置で決まるので、同じ位置でcommandを替えた時は同じ鍵のhashを書き直す。
export async function trustCodexHook(home, hooksFile, withCodexAppServer, env, command = CODEX_RTK_COMMAND) {
  const source = await realpath(hooksFile)
  await withCodexAppServer(env, async request => {
    const list = async () => ((await request('hooks/list', { cwds: [join(home, '.codex')] }))?.data?.[0]?.hooks ?? [])
      .filter(hook => hook.command === command && hook.sourcePath === source)
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

async function writeGrokHook(home, entry) {
  const path = join(home, '.grok/hooks/rtk.json')
  await mkdir(dirname(path), { recursive: true })
  const next = `${JSON.stringify(grokHookConfig(appRoot, entry), null, 2)}\n`
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
