#!/usr/bin/env node
// bd10: Bridge's connection export on stdin -> the RUNNING server's callBridge settings, so there is one settings writer.
// Host (as kite, cwd /home/kite/call-bridge): python3 scripts/export_connection.py --json | docker exec -i bellteam node /app/scripts/import-call-bridge.mjs
// Loopback Host = authMode 'local' = Owner, so the token may be given as a value. Nothing read from stdin is ever printed.
import { callBridgeSettingsInput } from '../src/usage/call-bridge-import.mjs'

const MAX_BYTES = 64 * 1024
const fail = code => { process.stderr.write(`${code}\n`); process.exit(1) }

const chunks = []
let size = 0
for await (const chunk of process.stdin) {
  size += chunk.length
  if (size > MAX_BYTES) fail('CALL_BRIDGE_IMPORT_TOO_LARGE')
  chunks.push(chunk)
}
let body
try { body = callBridgeSettingsInput(Buffer.concat(chunks)) } catch (error) { fail(error?.code ?? 'CALL_BRIDGE_IMPORT_INVALID') }
const port = Number(process.env.BELLTEAM_WEB_PORT ?? 4180)
let response
try {
  response = await fetch(`http://127.0.0.1:${port}/api/settings/callBridge`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
} catch { fail('CALL_BRIDGE_IMPORT_UNREACHABLE') }
if (!response.ok) {
  const error = await response.json().then(value => value?.error, () => null)
  fail(`CALL_BRIDGE_IMPORT_REFUSED ${response.status}${typeof error === 'string' && /^[A-Z_]{1,64}$/u.test(error) ? ` ${error}` : ''}`)
}
process.stdout.write('通話ブリッジの接続を設定に取り込みました。\n')
