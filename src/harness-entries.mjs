// bd14: BellTeam is the one writer of the MCP entries and hooks of the products in config/harness-products.json (E1/E2, cli-registration.md).
// Each (product, server, harness) entry and each hook event is applied only when the seat's current content differs; an invalid product file keeps that product's state.
import { execFile } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual, promisify } from 'node:util'
import { writeAtomic } from './json-file.mjs'
import { codexAppServer, trustCodexHook } from './rtk-hooks.mjs'
import { runtimeEnvironment } from './runtime-home.mjs'

const HARNESSES = ['claude', 'codex', 'grok', 'cursor', 'gemini']
const HOOK_HARNESSES = ['claude', 'codex', 'cursor', 'grok']
// Hook files no CLI writes. claude/codex hold native groups {matcher?, hooks:[item]} per event, cursor holds native items; grok is one whole file per product.
const HOOK_FILES = { claude: '.claude/settings.json', codex: '.codex/hooks.json', cursor: '.cursor/hooks.json' }
const REGISTRY = fileURLToPath(new URL('../config/harness-products.json', import.meta.url))
const execFileAsync = promisify(execFile)
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
// E1 merge rule (contract v1.1): the product's declared keys win; existing keys it does not declare stay; env merges by key (E1 wins), so env:{} clears nothing.
export const mergeEntry = (current, entry) => isObject(current)
  ? { ...current, ...entry, ...(isObject(current.env) || isObject(entry.env) ? { env: { ...current.env, ...entry.env } } : {}) }
  : entry

// Reports reach the body log (docker logs): a failed CLI call carries its whole argv (entries with tokens/headers/env) and a JSON
// parse error quotes the file text, so only our own messages pass through as written.
export const safeMessage = error => error?.cmd !== undefined ? `${String(error.cmd).split(' ')[0]} が終了コード ${error.code ?? error.signal ?? '不明'} で失敗しました`
  : error instanceof SyntaxError ? 'JSON として読めません' : String(error?.message ?? error)

async function readJson(path) {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/u, '')) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

// E1 v1.1 check. Returns { servers: [{ name, harness, entry }], hooks: { <harness>: native }, owns, version }. Permissions and settings are a later slice.
export function parseEntries(product, value) {
  if (!isObject(value) || value.schema !== 'bellteam.harness-entries.v1') throw new Error('schema is not bellteam.harness-entries.v1')
  if (value.product !== product) throw new Error(`product is ${JSON.stringify(value.product)}, not ${product}`)
  for (const key of ['permissions', 'settings']) {
    if (isObject(value[key]) && Object.keys(value[key]).length) throw new Error(`has ${key}, out of scope for the MCP and hooks slice`)
  }
  const hooks = value.hooks ?? {}
  if (!isObject(hooks)) throw new Error('hooks is not an object')
  for (const [harness, native] of Object.entries(hooks)) {
    if (!HOOK_HARNESSES.includes(harness)) throw new Error(`hooks.${harness}: unknown harness`)
    if (!isObject(native)) throw new Error(`hooks.${harness} is not an object`)
    if (harness === 'grok') continue
    for (const [event, list] of Object.entries(native)) {
      if (!Array.isArray(list) || !list.every(isObject)) throw new Error(`hooks.${harness}.${event} is not an array of objects`)
      if (harness !== 'cursor' && !list.every(group => Array.isArray(group.hooks) && group.hooks.every(isObject))) throw new Error(`hooks.${harness}.${event}: a group has no hooks array`)
    }
  }
  const owns = value.owns?.commandIncludes ?? []
  if (!Array.isArray(owns) || !owns.every(part => typeof part === 'string' && part)) throw new Error('owns.commandIncludes is not an array of strings')
  if (!isObject(value.mcpServers)) throw new Error('mcpServers is not an object')
  const servers = []
  for (const [name, byHarness] of Object.entries(value.mcpServers)) {
    if (!isObject(byHarness)) throw new Error(`mcpServers.${name} is not an object`)
    for (const [harness, entry] of Object.entries(byHarness)) {
      if (!HARNESSES.includes(harness)) throw new Error(`mcpServers.${name}.${harness}: unknown harness`)
      if (!isObject(entry)) throw new Error(`mcpServers.${name}.${harness} is not an object`)
      servers.push({ name, harness, entry })
    }
  }
  return { servers, hooks, owns, version: value.version }
}

export async function configureHarnessEntries(home, { registry = REGISTRY, run = execFileAsync, appServer = codexAppServer, report = message => process.stderr.write(`${message}\n`) } = {}) {
  const env = runtimeEnvironment(process.env, home)
  const recordPath = join(home, '.bellteam-cli-registration/applied.json')
  const applied = (await readJson(recordPath).catch(() => null)) ?? {}
  const items = [], hookProducts = []
  // A missing E2 is a packaging fault (Z4 lab 2026-11-14): fail loudly; configureHarnesses reports it and writes nothing.
  const products = await readJson(registry)
  if (!Array.isArray(products)) throw new Error(`E2 ${registry} がありません`)
  for (const { product, file } of products) {
    try {
      const value = await readJson(file)
      if (value === null) throw new Error(`${file} がありません`)
      const { servers, hooks, owns, version } = parseEntries(product, value)
      applied[product] = { version, entries: [] }
      items.push(...servers.map(item => ({ ...item, product })))
      if (Object.keys(hooks).length) hookProducts.push({ product, hooks, owns })
    } catch (error) {
      report(`BellTeam MCP ${product}: E1を使えないので現在の状態のままにします（${safeMessage(error)}）`)
    }
  }

  let grokList
  const sync = {
    async claude({ name, entry }) {
      const current = (await readJson(join(home, '.claude.json')))?.mcpServers?.[name]
      const wanted = mergeEntry(current, entry)
      if (isDeepStrictEqual(current, wanted)) return
      const add = value => run('claude', ['mcp', 'add-json', name, JSON.stringify(value), '--scope', 'user'], { env })
      if (current !== undefined) await run('claude', ['mcp', 'remove', name, '--scope', 'user'], { env })
      await replaceOrRestore(() => add(wanted), current === undefined ? null : () => add(current))
    },
    // `grok mcp add` has no flag for startup_timeout_sec and the like: such a differing entry is reported, never hand-edited into the TOML.
    async grok({ name, entry }) {
      grokList ??= run('grok', ['mcp', 'list', '--json'], { env, cwd: home }).then(({ stdout }) => JSON.parse(stdout))
      const current = (await grokList).find(server => server.name === name && server.scope === 'user')
      const { name: _name, scope: _scope, ...native } = current ?? {}
      const merged = mergeEntry(current ? native : undefined, entry)
      const wanted = { enabled: true, ...merged, ...(merged.command !== undefined && merged.args === undefined ? { args: [] } : {}) }
      if (current && isDeepStrictEqual(native, wanted)) return
      const { enabled, url, command, args, headers, env: serverEnv, ...rest } = wanted
      const missing = [...Object.keys(rest), ...(enabled !== undefined && enabled !== true ? ['enabled'] : [])]
      if (missing.length || (url === undefined) === (command === undefined)) throw new Error(`grok mcp addでは ${missing.join(', ') || 'url/command'} を書けません`)
      const add = ({ url, command, args, headers, env: serverEnv }) => run('grok', ['mcp', 'add', name, '--scope', 'user',
        ...Object.entries(serverEnv ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]), ...Object.entries(headers ?? {}).flatMap(([key, value]) => ['-H', `${key}: ${value}`]),
        ...(url !== undefined ? ['--transport', 'http', url] : ['--', command, ...(args ?? [])])], { env, cwd: home })
      if (current) await run('grok', ['mcp', 'remove', name, '--scope', 'user'], { env, cwd: home })
      await replaceOrRestore(() => add({ url, command, args, headers, env: serverEnv }), current ? () => add(native) : null)
    },
    cursor: item => mergeJson(join(home, '.cursor/mcp.json'), item),
    gemini: item => mergeJson(join(home, '.gemini/config/mcp_config.json'), item),
  }
  const done = item => applied[item.product].entries.push(`${item.harness}:${item.name}`)
  const failed = (item, error) => report(`BellTeam MCP ${item.product}: ${item.harness} の ${item.name} を適用できませんでした（${safeMessage(error)}${error?.restoreFailure ?? ''}）`)

  for (const harness of ['claude', 'grok', 'cursor', 'gemini']) {
    for (const item of items.filter(entry => entry.harness === harness)) {
      try { await sync[harness](item); done(item) } catch (error) { failed(item, error) }
    }
  }
  const codexItems = items.filter(item => item.harness === 'codex')
  if (codexItems.length) {
    try {
      await appServer(env, async request => {
        const read = async () => (await request('config/read', { cwd: join(home, '.codex'), includeLayers: false }))?.config?.mcp_servers ?? {}
        const current = await read()
        for (const item of codexItems) {
          try {
            if (!codexMatches(current[item.name], item.entry)) {
              const keyPath = /^[\w-]+$/u.test(item.name) ? `mcp_servers.${item.name}` : `mcp_servers.${JSON.stringify(item.name)}`
              await request('config/batchWrite', { edits: [{ keyPath, value: item.entry, mergeStrategy: 'upsert' }], filePath: join(home, '.codex/config.toml') })
              if (!codexMatches((await read())[item.name], item.entry)) throw new Error('書いた後の読み戻しが一致しません')
            }
            done(item)
          } catch (error) { failed(item, error) }
        }
      })
    } catch (error) {
      report(`BellTeam MCP: Codexのapp-serverを使えませんでした（${safeMessage(error)}）`)
    }
  }

  // Hooks, in E2 order; each (product, harness) is read and written alone, so a failure leaves only that file as it was.
  for (const { product, hooks, owns } of hookProducts) {
    for (const [harness, native] of Object.entries(hooks)) {
      try {
        if (harness === 'grok') await writeGrokHooks(join(home, '.grok/hooks', `${product}.json`), native)
        else await patchHookFile(join(home, HOOK_FILES[harness]), harness, native, owns)
        // Codex trusts a handler by its position and hash: hooks/list is read every pass and writes only for an untrusted handler.
        if (harness === 'codex') for (const command of new Set(Object.values(native).flat().flatMap(group => group.hooks).map(item => item.command).filter(Boolean)))
          await trustCodexHook(home, join(home, HOOK_FILES.codex), appServer, env, command)
        applied[product].entries.push(...(harness === 'grok' ? ['grok:hooks'] : Object.keys(native).map(event => `${harness}:hooks:${event}`)))
      } catch (error) {
        report(`BellTeam hook ${product}: ${harness} のhookを適用できませんでした（${safeMessage(error)}）`)
      }
    }
  }

  const before = await readFile(recordPath, 'utf8').catch(() => null)
  if (before !== `${JSON.stringify(applied, null, 2)}\n`) {
    await mkdir(dirname(recordPath), { recursive: true })
    await writeAtomic(recordPath, applied)
  }
}

// Patch only what the product owns: an existing item is the product's when its command equals an E1 command or contains an `owns` substring.
// The i-th existing item is replaced in place by the i-th E1 item (E1's declared fields win, the rest of the item and the group stay); E1 items beyond that are appended.
// More existing items than E1 items is a double registration: an error, the file stays as it was.
const owned = (item, wanted, owns) => typeof item?.command === 'string' && (wanted.some(entry => entry.command === item.command) || owns.some(part => item.command.includes(part)))

function patchGroups(groups, wanted, owns) {
  const items = wanted.flatMap(group => group.hooks.map(item => ({ group, item })))
  const found = groups.flatMap((group, at) => (Array.isArray(group?.hooks) ? group.hooks : []).flatMap((item, index) => owned(item, items.map(entry => entry.item), owns) ? [{ at, index, item }] : []))
  if (found.length > items.length) throw new Error(`既存の登録が${found.length}件あり、E1の${items.length}件に対応しません`)
  const next = groups.map(group => Array.isArray(group?.hooks) ? { ...group, hooks: [...group.hooks] } : group)
  found.forEach(({ at, index, item }, i) => { next[at].hooks[index] = { ...item, ...items[i].item } })
  const added = new Map()
  for (const { group, item } of items.slice(found.length)) added.set(group, [...(added.get(group) ?? []), item])
  return [...next, ...[...added].map(([group, hooks]) => ({ ...group, hooks }))]
}

function patchItems(list, wanted, owns) {
  const found = list.flatMap((item, index) => owned(item, wanted, owns) ? [index] : [])
  if (found.length > wanted.length) throw new Error(`既存の登録が${found.length}件あり、E1の${wanted.length}件に対応しません`)
  const next = [...list]
  found.forEach((index, i) => { next[index] = { ...list[index], ...wanted[i] } })
  return [...next, ...wanted.slice(found.length)]
}

async function patchHookFile(path, harness, native, owns) {
  const current = await readJson(path) ?? {}
  const section = current.hooks ?? {}
  if (!isObject(current) || !isObject(section)) throw new Error(`${path} のhooksがobjectではありません`)
  let hooks = section
  for (const [event, wanted] of Object.entries(native)) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) throw new Error(`${path} の${event}が配列ではありません`)
    hooks = { ...hooks, [event]: (harness === 'cursor' ? patchItems : patchGroups)(hooks[event] ?? [], wanted, owns) }
  }
  if (isDeepStrictEqual(hooks, section)) return
  await mkdir(dirname(path), { recursive: true })
  await writeAtomic(path, harness === 'cursor' ? { version: 1, ...current, hooks } : { ...current, hooks })
}

async function writeGrokHooks(path, native) {
  const next = `${JSON.stringify(native, null, 2)}\n`
  if (await readFile(path, 'utf8').catch(() => null) === next) return
  await mkdir(dirname(path), { recursive: true })
  await writeAtomic(path, native)
}

// The CLIs have no in-place replace: remove then add. If the add fails, the previous entry is added back through the same CLI,
// so the seat never loses the server (named protection: no data loss); the original error is still reported.
async function replaceOrRestore(add, restore) {
  try { await add() } catch (error) {
    if (restore) await restore().catch(cause => { error.restoreFailure = `; 元の登録も戻せませんでした（${safeMessage(cause)}）` })
    throw error
  }
}

async function mergeJson(path, { name, entry }) {
  const current = await readJson(path) ?? {}
  const wanted = mergeEntry(current.mcpServers?.[name], entry)
  if (isDeepStrictEqual(current.mcpServers?.[name], wanted)) return
  await mkdir(dirname(path), { recursive: true })
  await writeAtomic(path, { ...current, mcpServers: { ...current.mcpServers, [name]: wanted } })
}

// Merge rule: only the keys E1 declares must match (env: only E1's env keys); keys E1 does not declare are the seat's and stay (upsert).
function codexMatches(current, entry) {
  if (!isObject(current)) return false
  return Object.entries(entry).every(([key, value]) => key === 'env' && isObject(value)
    ? Object.entries(value).every(([name, item]) => isDeepStrictEqual(current.env?.[name], item))
    : isDeepStrictEqual(current[key], value))
}
