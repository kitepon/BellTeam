// Container user-global MCP servers per harness (remote-user-tools.md U1/U2). Runs as the seat user (UID 1000):
// the body only ever receives names and kinds; command/env/url/headers stay with the process that runs the tool.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// The servers BellTeam itself writes into every harness config (harness-config.mjs). One list, used there and here.
export const MANAGED_MCP_IDS = Object.freeze(['bellteam', 'aiterm', 'call-bridge'])
// Aiterm's caller-file name rule (parseCallerMcp MCP_SERVER_NAME).
const CALLER_NAME = /^[A-Za-z0-9_-]{1,64}$/u

export const USER_TOOL_FILES = Object.freeze({
  claude: { path: '.claude.json', format: 'json' },
  codex: { path: '.codex/config.toml', format: 'toml' },
  grok: { path: '.grok/config.toml', format: 'toml' },
  cursor: { path: '.cursor/mcp.json', format: 'json' },
})
const HARNESS_ALIASES = { 'claude-code': 'claude', 'codex-cli': 'codex', 'grok-cli': 'grok', 'cursor-cli': 'cursor' }
export const userToolHarness = harness => HARNESS_ALIASES[harness] ?? (Object.hasOwn(USER_TOOL_FILES, harness) ? harness : null)

const failure = code => Object.assign(new Error(code), { code })

// Minimal TOML for [mcp_servers.<name>] tables: strings, booleans, numbers, string arrays and inline tables of strings.
function parseValue(text) {
  const source = text.trim()
  let index = 0
  const space = () => { while (index < source.length && /\s/u.test(source[index])) index++ }
  const value = () => {
    space()
    const char = source[index]
    if (char === '"') {
      let out = ''; index++
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\') { const next = source[++index]; out += { n: '\n', t: '\t', '"': '"', '\\': '\\', r: '\r' }[next] ?? next; index++ }
        else out += source[index++]
      }
      index++; return out
    }
    if (char === "'") { const end = source.indexOf("'", index + 1); const out = source.slice(index + 1, end); index = end + 1; return out }
    if (char === '[') {
      index++; const out = []
      for (;;) { space(); if (source[index] === ']') { index++; return out } out.push(value()); space(); if (source[index] === ',') index++ }
    }
    if (char === '{') {
      index++; const out = {}
      for (;;) {
        space(); if (source[index] === '}') { index++; return out }
        const key = /^("([^"]*)"|'([^']*)'|[A-Za-z0-9_-]+)/u.exec(source.slice(index))
        if (!key) throw failure('USER_TOOL_CONFIG_INVALID')
        index += key[0].length; space(); if (source[index] !== '=') throw failure('USER_TOOL_CONFIG_INVALID'); index++
        out[key[2] ?? key[3] ?? key[1]] = value(); space(); if (source[index] === ',') index++
      }
    }
    const bare = /^[^,\]}\s#]+/u.exec(source.slice(index))?.[0] ?? ''
    index += bare.length
    if (bare === 'true') return true
    if (bare === 'false') return false
    if (/^[+-]?\d+(\.\d+)?$/u.test(bare)) return Number(bare)
    return undefined
  }
  return value()
}

const tableName = header => [...header.matchAll(/"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+)/gu)].map(match => match[1] ?? match[2] ?? match[3])

export function parseTomlMcpServers(text) {
  const servers = {}
  let target = null
  // Join multi-line arrays/inline tables onto one logical line.
  const lines = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s+/u, '')
    const last = lines.at(-1)
    if (last !== undefined && (count(last, '[') > count(last, ']') || count(last, '{') > count(last, '}')) && !/^\[/u.test(line)) lines[lines.length - 1] = `${last} ${line}`
    else lines.push(line)
  }
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue
    const header = /^\[([^\[\]]+)\]\s*(#.*)?$/u.exec(line)
    if (header) {
      const path = tableName(header[1])
      target = path[0] === 'mcp_servers' && path.length >= 2 ? { name: path[1], sub: path.slice(2) } : null
      if (target) servers[target.name] ??= {}
      continue
    }
    if (!target) continue
    const pair = /^("([^"]*)"|'([^']*)'|[A-Za-z0-9_-]+)\s*=\s*(.*)$/u.exec(line)
    if (!pair) continue
    let value
    try { value = parseValue(pair[4].replace(/\s+#[^"']*$/u, '')) } catch { continue }
    if (value === undefined) continue
    let node = servers[target.name]
    for (const key of target.sub) node = node[key] ??= {}
    node[pair[2] ?? pair[3] ?? pair[1]] = value
  }
  return servers
}
function count(text, char) { let n = 0; let quoted = null; for (const c of text) { if (quoted) { if (c === quoted) quoted = null } else if (c === '"' || c === "'") quoted = c; else if (c === char) n++ } return n }

export function readUserMcpServers(harness, home = homedir()) {
  const key = userToolHarness(harness)
  if (!key) throw failure('USER_TOOL_HARNESS_UNSUPPORTED')
  const file = USER_TOOL_FILES[key]
  let text
  try { text = readFileSync(join(home, file.path), 'utf8') } catch (error) { if (error.code === 'ENOENT') return {}; throw failure('USER_TOOL_CONFIG_UNREADABLE') }
  if (file.format === 'toml') return parseTomlMcpServers(text)
  let value
  try { value = JSON.parse(text) } catch { throw failure('USER_TOOL_CONFIG_INVALID') }
  const servers = value?.mcpServers
  return servers && typeof servers === 'object' && !Array.isArray(servers) ? servers : {}
}

// stdio: a command to run. http: a Streamable HTTP url. Anything else (sse, unknown) is not carried.
export function userToolKind(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null
  if (spec.enabled === false || spec.disabled === true) return null
  const url = spec.url ?? spec.serverUrl ?? spec.httpUrl
  if (spec.type === 'sse' || spec.transport === 'sse') return null
  if (typeof spec.command === 'string' && spec.command) return 'stdio'
  if (typeof url === 'string' && /^https?:\/\//u.test(url)) return 'http'
  return null
}

// U1: names and kinds only.
export function listUserTools(harness, home = homedir()) {
  return Object.entries(readUserMcpServers(harness, home))
    .filter(([name]) => CALLER_NAME.test(name) && !MANAGED_MCP_IDS.includes(name))
    .map(([name, spec]) => ({ name, kind: userToolKind(spec) }))
    .filter(entry => entry.kind)
}

// U2: the full spec, only inside the seat-user process that runs it.
export function findUserTool(harness, name, home = homedir()) {
  if (!CALLER_NAME.test(name) || MANAGED_MCP_IDS.includes(name)) throw failure('USER_TOOL_NOT_CONFIGURED')
  const spec = readUserMcpServers(harness, home)[name]
  const kind = userToolKind(spec)
  if (!kind) throw failure('USER_TOOL_NOT_CONFIGURED')
  return { kind, spec }
}

// ${VAR}, ${VAR:-default} (claude) and ${env:VAR} (cursor) from the seat user's environment.
export function expandUserToolValue(value, env = process.env) {
  return typeof value === 'string'
    ? value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/gu, (_, name, fallback) => env[name] ?? fallback ?? '')
    : value
}

// Headers for an http tool: literal/expanded headers, codex env_http_headers and bearer_token_env_var.
export function userToolHeaders(spec, env = process.env) {
  const headers = {}
  for (const source of [spec.headers, spec.http_headers]) {
    if (source && typeof source === 'object') for (const [key, value] of Object.entries(source)) if (typeof value === 'string') headers[key] = expandUserToolValue(value, env)
  }
  if (spec.env_http_headers && typeof spec.env_http_headers === 'object') {
    for (const [key, variable] of Object.entries(spec.env_http_headers)) if (typeof variable === 'string' && env[variable] !== undefined) headers[key] = env[variable]
  }
  if (typeof spec.bearer_token_env_var === 'string' && env[spec.bearer_token_env_var]) headers.Authorization = `Bearer ${env[spec.bearer_token_env_var]}`
  return headers
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === 'list') {
  try { process.stdout.write(`${JSON.stringify({ schema: 'bellteam.user-tools.v1', tools: listUserTools(process.argv[3]) })}\n`) }
  catch (error) { process.stdout.write(`${JSON.stringify({ schema: 'bellteam.user-tools.v1', error: error.code ?? 'USER_TOOL_LIST_FAILED' })}\n`); process.exitCode = 1 }
}
