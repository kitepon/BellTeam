#!/usr/bin/env node
// Run on the main server before deploying either container. This changes only
// persistent configuration and does not restart a service.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const bellTeamRoot = process.env.BELLTEAM_DEPLOY_ROOT || '/home/kite/BellTeam'
const bridgeRoot = process.env.CALL_BRIDGE_DEPLOY_ROOT || '/home/kite/call-bridge'
const socketDir = join(bellTeamRoot, 'runtime/data/shared/tools/call-bridge')
const socketPath = join(socketDir, 'bellteam.sock')
const config = JSON.parse(execFileSync('docker', ['compose', 'config', '--format', 'json'], {
  cwd: bridgeRoot, encoding: 'utf8', maxBuffer: 1024 * 1024,
}))
const service = config.services?.['call-bridge'] ?? config.services?.['grokbot-bridge']
const token = service?.environment?.CALL_BRIDGE_TOKEN
if (token !== undefined && (typeof token !== 'string' || !token || /[\r\n]/u.test(token))) {
  throw new Error('call-bridge の CALL_BRIDGE_TOKEN が空、または改行を含む')
}

mkdirSync(socketDir, { recursive: true, mode: 0o700 })
chmodSync(socketDir, 0o700)
const headerPath = join(socketDir, 'headers')
const legacyHeader = token ? `Authorization: Bearer ${token}\n` : null
let currentHeader = null
try {
  currentHeader = readFileSync(headerPath, 'utf8')
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
// A BellTeam token issued by the bridge's scripts/issue_token.py
// (--format header --out <this file>) replaces the shared token here.
// Keep it; only create or refresh the shared-token header. Once the shared
// token is retired, the issued header is required.
const keepIssued = currentHeader !== null && currentHeader !== legacyHeader && /^Authorization: Bearer \S+\n$/u.test(currentHeader)
if (!keepIssued && !legacyHeader) {
  throw new Error('共通トークンが止まっている。ブリッジの scripts/issue_token.py で BellTeam 用トークンを headers へ発行する')
}
if (!keepIssued) {
  const tempPath = join(socketDir, `headers.${process.pid}.tmp`)
  writeFileSync(tempPath, legacyHeader, { mode: 0o600 })
  renameSync(tempPath, headerPath)
}
chmodSync(headerPath, 0o600)

function setEnv(path, key, value) {
  const current = readFileSync(path, 'utf8')
  let found = false
  const lines = current.split(/\r?\n/u).filter(line => {
    if (!line.startsWith(`${key}=`)) return true
    if (found) return false
    found = true
    return true
  }).map(line => line.startsWith(`${key}=`) ? `${key}=${value}` : line)
  while (lines.at(-1) === '') lines.pop()
  if (!found) lines.push(`${key}=${value}`)
  const next = lines.join('\n') + '\n'
  if (next !== current) writeFileSync(path, next, { mode: 0o600 })
}

setEnv(join(bellTeamRoot, '.env'), 'BELLTEAM_CALL_BRIDGE_SOCKET', '/srv/bellteam/shared/tools/call-bridge/bellteam.sock')
setEnv(join(bellTeamRoot, '.env'), 'BELLTEAM_CALL_BRIDGE_MCP_URL', 'http://192.168.1.2:18910/mcp')
setEnv(join(bridgeRoot, '.env'), 'CALL_BRIDGE_BELLTEAM_SOCKET_HOST', socketDir)
process.stdout.write(`通話MCPの認証ファイルと接続設定を準備しました: ${socketDir}${keepIssued ? '（発行済みのBellTeamトークンを保持）' : ''}\n`)
