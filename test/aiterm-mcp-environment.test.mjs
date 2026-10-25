import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { writeHarnessConfig } from '../src/harness-config.mjs'

const names = ['AITERM_SESSION_ID', 'AITERM_AGENT_SESSION_ID', 'AITERM_AGENT_LAUNCH_ID', 'AITERM_STATE_BASE', 'TMPDIR', 'XDG_RUNTIME_DIR', 'TEMP', 'TMP']
const fixture = `
let body = ''
for await (const chunk of process.stdin) body += chunk
process.stdout.write(JSON.stringify({body, env: Object.fromEntries(${JSON.stringify(names)}.filter(name => Object.hasOwn(process.env, name)).map(name => [name, process.env[name]]))}))
process.exitCode = 37
`
async function cursorRegistration(source = fixture) {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-mcp-env-'))
  const target = join(home, 'fake.mjs')
  await writeFile(target, source)
  await writeHarnessConfig(new Map(), home, {
    environment: {},
    aiterm: async () => ({ command: process.execPath, args: [target] }),
    relay: async () => null,
  })
  return JSON.parse(await readFile(join(home, '.cursor/mcp.json'), 'utf8')).mcpServers.aiterm
}
// Simulate Cursor's documented interpolation; this is not a live CLI check.
function resolve(registration, cliEnv) {
  return Object.fromEntries(Object.entries(registration.env).map(([key, value]) =>
    [key, value.replace(/\$\{env:([^}]+)\}/gu, (reference, name) => cliEnv[name] ?? reference)]))
}
async function run(registration, env) {
  const child = spawn(registration.command, registration.args, { env, stdio: 'pipe' })
  const output = [], errors = []
  child.stdout.on('data', chunk => output.push(chunk))
  child.stderr.on('data', chunk => errors.push(chunk))
  child.stdin.end('synthetic-stdio\n')
  const [code, signal] = await once(child, 'close')
  return { code, signal, output: Buffer.concat(output).toString(), errors: Buffer.concat(errors).toString() }
}

test('Cursorの後付けsource/state/socket変数をstdio MCPへ保持し、入出力と終了値を変えない', async () => {
  const registration = await cursorRegistration()
  const cliEnv = {
    AITERM_SESSION_ID: 'codex:synthetic', AITERM_AGENT_SESSION_ID: 'codex:synthetic',
    AITERM_AGENT_LAUNCH_ID: 'synthetic-launch', AITERM_STATE_BASE: '/synthetic/state dir',
    TMPDIR: '/synthetic/socket dir', XDG_RUNTIME_DIR: '/synthetic/runtime',
    TEMP: 'C:\\synthetic temp', TMP: 'C:\\synthetic tmp',
  }
  const result = await run(registration, resolve(registration, cliEnv))
  assert.equal(result.code, 37)
  assert.equal(result.signal, null)
  assert.equal(result.errors, '')
  assert.deepEqual(JSON.parse(result.output), { body: 'synthetic-stdio\n', env: cliEnv })
})

test('未定義のruntime/state/temp参照は除き、session別名だけの場合も補完しない', async () => {
  const registration = await cursorRegistration()
  const cliEnv = { AITERM_AGENT_SESSION_ID: 'codex:alias', AITERM_AGENT_LAUNCH_ID: 'synthetic-launch' }
  const result = await run(registration, resolve(registration, cliEnv))
  assert.equal(result.code, 37)
  assert.deepEqual(JSON.parse(result.output).env, cliEnv)
})

test('既存の不一致source値は書き換えずAiterm側の照合へ渡す', async () => {
  const registration = await cursorRegistration()
  const cliEnv = { AITERM_SESSION_ID: 'codex:one', AITERM_AGENT_SESSION_ID: 'codex:two', AITERM_AGENT_LAUNCH_ID: 'synthetic-launch' }
  const result = await run(registration, resolve(registration, cliEnv))
  assert.deepEqual(JSON.parse(result.output).env, cliEnv)
})

test('MCPの起動失敗は環境値や引数を出さず非0で返す', async () => {
  const registration = await cursorRegistration()
  registration.args = [registration.args[0], '/synthetic-does-not-exist/private-argument']
  const result = await run(registration, resolve(registration, {}))
  assert.equal(result.code, 1)
  assert.equal(result.output, '')
  assert.equal(result.errors, 'AITERM_MCP_START_FAILED\n')
})

test('POSIXでは終了signalを合成MCPへ渡し、終了まで待つ', { skip: process.platform === 'win32' }, async () => {
  const registration = await cursorRegistration("process.stdout.write('ready\\n'); setInterval(() => {}, 1000)")
  const child = spawn(registration.command, registration.args, { env: resolve(registration, {}), stdio: 'pipe' })
  const closed = once(child, 'close')
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  try {
    await once(child.stdout, 'data')
    child.kill('SIGTERM')
    const [code, signal] = await closed
    assert.equal(code, null)
    assert.equal(signal, 'SIGTERM')
  } finally { clearTimeout(timer) }
})
