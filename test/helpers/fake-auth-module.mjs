import { createServer as createNetServer } from 'node:net'
import { request as httpRequest } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A stand-in for the auth module's caller socket (F23 http-stream): reads one request line, checks the item name and the header allow-list,
// makes the request to `upstream` with the credential added, and answers the line + frames (5 head, 1 body, 3 end). mode.refuse = a refusal line.
export async function fakeAuthModule(t, { upstream, item = 'call-bridge-mcp-bellteam', credential = 'Bearer secret-token', allowHeaders = ['x-call-bridge-caller-id', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id', 'mcp-method', 'mcp-name', 'accept', 'content-type'] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bellteam-fake-auth-'))
  const socket = join(directory, 'bellteam-body.sock')
  const state = { requests: [], refuse: null, open: 0 }
  const frame = (tag, data) => { const body = Buffer.from(data); const head = Buffer.alloc(5); head[0] = tag; head.writeUInt32BE(body.length, 1); return Buffer.concat([head, body]) }
  const server = createNetServer(connection => {
    let line = ''
    connection.on('error', () => {})
    connection.on('data', chunk => {
      line += chunk
      if (!line.includes('\n')) return
      const request = JSON.parse(line.split('\n')[0]); line = ''
      state.requests.push(request)
      if (state.refuse) return connection.end(JSON.stringify({ outcome: state.refuse, error: 'PRIVATE' }) + '\n')
      if (request.op !== 'http-stream' || request.name !== item) return connection.end(JSON.stringify({ outcome: 'not-registered' }) + '\n')
      const headers = Object.fromEntries(Object.entries(request.headers ?? {}).filter(([name]) => allowHeaders.includes(name.toLowerCase())))
      const url = new URL(upstream)
      const call = httpRequest({ hostname: url.hostname, port: url.port, path: request.path, method: request.method, headers: { ...headers, authorization: credential } }, answer => {
        connection.write(JSON.stringify({ outcome: 'granted' }) + '\n')
        connection.write(frame(5, JSON.stringify({ status: answer.statusCode, headers: Object.fromEntries(Object.entries(answer.headers).filter(([, v]) => typeof v === 'string')) })))
        state.open++
        answer.on('data', data => connection.write(frame(1, data)))
        answer.on('end', () => { state.open--; connection.write(frame(3, '0')); connection.end() })
        answer.on('aborted', () => { state.open--; connection.destroy() })
        answer.on('error', () => connection.destroy())
      })
      call.on('error', () => connection.end(JSON.stringify({ outcome: 'error', error: 'upstream' }) + '\n'))
      connection.on('close', () => call.destroy())
      call.end(request.body ? Buffer.from(request.body, 'base64') : undefined)
    })
  })
  await new Promise(resolve => server.listen(socket, resolve))
  t.after(async () => { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }) })
  return { socket, state, directory }
}
