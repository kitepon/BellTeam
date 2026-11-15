// U2 (remote-user-tools.md): runs one user-global MCP server for one terminal seat, as the seat user, speaking
// newline-delimited JSON-RPC on stdin/stdout to the body's relay. Credentials are read and used only here.
// Usage: node run-user-tool.mjs <harness> <name>
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { expandUserToolValue, findUserTool, userToolHeaders } from './user-tools.mjs'

const [harness, name] = process.argv.slice(2)
const fail = code => { process.stderr.write(`${code}\n`); process.exit(3) }

let tool
try { tool = findUserTool(harness, name) } catch (error) { fail(error.code ?? 'USER_TOOL_NOT_CONFIGURED') }
const { kind, spec } = tool

if (kind === 'stdio') {
  const env = { ...process.env, ...Object.fromEntries(Object.entries(spec.env ?? {}).filter(([, value]) => typeof value === 'string')
    .map(([key, value]) => [key, expandUserToolValue(value)])) }
  const args = Array.isArray(spec.args) ? spec.args.filter(value => typeof value === 'string').map(value => expandUserToolValue(value)) : []
  const child = spawn(expandUserToolValue(spec.command), args, { stdio: 'inherit', env, ...(typeof spec.cwd === 'string' ? { cwd: spec.cwd } : {}) })
  child.on('error', () => fail('USER_TOOL_START_FAILED'))
  child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0))
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal))
} else {
  // http: one MCP client of the configured upstream; relays each stdin message and writes every reply message.
  const url = expandUserToolValue(spec.url ?? spec.serverUrl ?? spec.httpUrl)
  const headers = userToolHeaders(spec)
  let session = null
  let queue = Promise.resolve()
  const write = message => process.stdout.write(`${JSON.stringify(message)}\n`)
  const errorReply = (message, code) => { if (message?.id !== undefined && message.method) write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: code } }) }
  const send = async line => {
    let message
    try { message = JSON.parse(line) } catch { return }
    let response
    try {
      response = await fetch(url, { method: 'POST', body: line, headers: { ...headers, 'content-type': 'application/json',
        accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) } })
    } catch { return errorReply(message, 'USER_TOOL_UPSTREAM_UNREACHABLE') }
    const next = response.headers.get('mcp-session-id')
    if (next) session = next
    if (response.status === 202 || response.status === 204) return
    const text = await response.text()
    if (!response.ok) return errorReply(message, `USER_TOOL_UPSTREAM_HTTP_${response.status}`)
    const type = response.headers.get('content-type') ?? ''
    const bodies = type.includes('text/event-stream')
      ? text.split(/\r?\n\r?\n/u).map(event => event.split(/\r?\n/u).filter(row => row.startsWith('data:')).map(row => row.slice(5).trimStart()).join('\n')).filter(Boolean)
      : [text]
    for (const body of bodies) {
      let value
      try { value = JSON.parse(body) } catch { continue }
      for (const item of Array.isArray(value) ? value : [value]) write(item)
    }
  }
  const lines = createInterface({ input: process.stdin })
  lines.on('line', line => { if (line.trim()) queue = queue.then(() => send(line)) })
  lines.on('close', () => queue.then(async () => {
    if (session) await fetch(url, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': session } }).catch(() => {})
    process.exit(0)
  }))
}
