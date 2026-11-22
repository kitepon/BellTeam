#!/usr/bin/env node
// a485: the host's own way in and out of the server's login (docs/architecture/modules/usage/app-sessions.md).
// One command over the body's private unix socket (0600), never HTTP:
//   bellteam-console setup-code | issue | list | revoke <sessionId> | reset-owner | addresses [list | add <origin> | remove <origin>]
import { createConnection } from 'node:net'

const socketPath = process.env.BELLTEAM_CONSOLE_SOCKET || '/run/bellteam-server/console.sock'
const [command, first, second] = process.argv.slice(2)
const request = {
  'setup-code': () => ({ op: 'setup-code' }),
  issue: () => ({ op: 'issue' }),
  list: () => ({ op: 'list' }),
  revoke: () => ({ op: 'revoke', id: first }),
  'reset-owner': () => ({ op: 'reset-owner' }),
  addresses: () => ({ op: 'addresses', action: first ?? 'list', address: second }),
}[command]
if (!request) { process.stderr.write('usage: bellteam-console setup-code | issue | list | revoke <sessionId> | reset-owner | addresses [list | add <origin> | remove <origin>]\n'); process.exit(2) }
const socket = createConnection(socketPath)
let text = ''
socket.setEncoding('utf8')
socket.on('connect', () => socket.write(`${JSON.stringify(request())}\n`))
socket.on('data', chunk => { text += chunk })
socket.on('error', error => { process.stderr.write(`bellteam-console: cannot reach ${socketPath} (${error.code})\n`); process.exit(1) })
socket.on('end', () => {
  let reply
  try { reply = JSON.parse(text) } catch { process.stderr.write('bellteam-console: no answer\n'); process.exit(1) }
  if (!reply.ok) { process.stderr.write(`bellteam-console: ${reply.error}\n`); process.exit(1) }
  const { ok: _ok, ...rest } = reply
  process.stdout.write(`${JSON.stringify(rest, null, 2)}\n`)
})
