import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { atLeast, doorHook, DOOR_MIN_AITERM } from '../src/terminals/approval-door.mjs'
import { Door, bearerOf, registerFromEnv, serveDoor, doorAddress, writeLog, windowsStart } from '../src/terminals/approval-door-host.mjs'
import { createTerminalConnection } from '../src/terminals/connection.mjs'
import { fakeNative, fakeSecrets } from './helpers/terminals-native-double.mjs'

const BEARER = `Bearer ${'A'.repeat(43)}`
const OTHER = `Bearer ${'B'.repeat(43)}`
const reply = (status, body) => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) })

test('the hook is sent only when both Aiterms carry post_launch, and fits Aiterm\'s argv limits', () => {
  assert.equal(DOOR_MIN_AITERM, '0.70.100')
  assert.equal(atLeast('0.70.100'), true)
  assert.equal(atLeast('0.70.99'), false)
  assert.equal(atLeast('0.71.0'), true)
  assert.equal(atLeast(null), false)
  assert.deepEqual(doorHook('0.70.99', '0.70.100'), {})
  assert.deepEqual(doorHook('0.70.100', '0.70.99'), {})
  assert.deepEqual(doorHook('0.70.100', undefined), {})
  const { command } = doorHook('0.70.100', '0.70.101').post_launch
  assert.equal(command[0], 'node')
  assert.ok(command.length >= 1 && command.length <= 16)
  assert.ok(command.every(item => !item.includes('\0')))
  assert.ok(command.reduce((sum, item) => sum + Buffer.byteLength(item), 0) <= 24 * 1024, 'Aiterm accepts at most 24 KiB of argv')
})

test('the terminal target carries the hook only when the open saw both versions new enough', async t => {
  const request = { terminalId: 'owner-macbook', memberId: 'bot-1', projectRoot: '/Users/kite/work/app', harness: 'claude-code' }
  const sshKeyRef = 'a1b2c3d4-1234-4234-8234-123456789abc'
  const record = { terminalId: 'owner-macbook', host: '192.168.1.12', user: 'kite', port: 22, os: 'macos', accountOwner: 'owner', sshKeyRef,
    hostTrust: { provider: 'aiterm.known-hosts.v1', revision: `sha256:${'a'.repeat(64)}` }, revision: 1 }
  const target = async (remoteVersion, localVersion) => {
    const native = fakeNative(); native.remoteVersion = remoteVersion; native.localVersion = localVersion
    const connection = createTerminalConnection({ registry: { async target() { return structuredClone(record) }, async update() {} }, secrets: fakeSecrets(), native, probeDelays: { first: 5, max: 10 } })
    t.after(() => connection.dispose())
    return connection.target(request)
  }
  assert.ok((await target('0.70.100', '0.70.100')).doorHook.post_launch.command.length >= 1)
  assert.equal(Object.hasOwn(await target('0.70.99', '0.70.100'), 'doorHook'), false)
  assert.equal(Object.hasOwn(await target('0.70.100', '0.70.99'), 'doorHook'), false)
})

test('Door: newest seat first, dead bearer dropped, fork skipped, daemon reply passed through, door_unavailable at the end', async () => {
  const calls = []
  const answers = { [BEARER]: reply(400, { error: 'BELLTEAM_SEAT_UNRESOLVED' }), [OTHER]: reply(200, '{"ok":true,"result":1}\n') }
  const door = new Door(async () => 0, async (url, init) => { calls.push([url, init.headers.authorization]); return answers[init.headers.authorization] })
  door.register('a', 40001, BEARER, ['x']); door.register('b', 40002, OTHER, ['x'])
  assert.equal(await door.forward('{"method":"GET"}'), '{"ok":true,"result":1}')
  assert.deepEqual(calls, [['http://127.0.0.1:40002/api/seat-mcp/approval-box/local', OTHER]])
  answers[OTHER] = reply(403, { error: 'APPROVAL_BOX_DOOR_NOT_ALLOWED' })
  const miss = JSON.parse(await door.forward('{}'))
  assert.deepEqual([miss.status, miss.code, miss.body], [503, 'door_unavailable', {}])
  assert.equal(door.size, 1, 'the 400 seat is dropped, the fork seat only skipped')
  answers[OTHER] = reply(500, 'oops')
  assert.equal(JSON.parse(await door.forward('{}')).code, 'APPROVAL_DOOR_HTTP_ERROR')
  const down = new Door(async () => 0, async () => { throw new Error('refused') }); down.register('a', 1, BEARER, ['x'])
  assert.match(JSON.parse(await down.forward('{}')).message, /not reachable/)
})

test('Door: registration is validated; a seat is dropped only after two confirmed absences in a row', async () => {
  const codes = [0, 1, 2, 1, 1]
  const door = new Door(async () => codes.shift())
  const ok = JSON.stringify({ bellteam_door: 'register', session: 's', port: 40001, authorization: BEARER, alive: ['/bin/true'] })
  assert.deepEqual(JSON.parse(await door.handle(ok)), { ok: true })
  for (const bad of [{ port: 0 }, { port: 70000 }, { authorization: 'Bearer short' }, { authorization: 'x' }, { alive: [] }, { alive: 'true' }, { session: '' }, { bellteam_door: 'other' }]) {
    const reply = JSON.parse(await door.handle(JSON.stringify({ ...JSON.parse(ok), ...bad })))
    assert.equal(reply.code, 'APPROVAL_DOOR_REGISTER_INVALID')
  }
  assert.equal(JSON.parse(await door.handle('{"bellteam_door": nope')).code, 'APPROVAL_DOOR_REGISTER_INVALID')
  assert.equal(await door.sweep(), 1) // 0: alive
  assert.equal(await door.sweep(), 1) // 1: one miss
  assert.equal(await door.sweep(), 1) // 2: cannot tell, the run of misses starts over
  assert.equal(await door.sweep(), 1) // 1: first miss again
  assert.equal(await door.sweep(), 0) // 1: second in a row, dropped
})

test('bearerOf reads a private header value or the seat token the header names, never anything else', () => {
  assert.equal(bearerOf({ AITERM_MCP_HEADER_0: BEARER }), BEARER)
  assert.equal(bearerOf({ BELLTEAM_MCP_TOKEN: 'A'.repeat(43) }), BEARER)
  assert.equal(bearerOf({ BELLTEAM_MCP_TOKEN: 'short', OTHER: BEARER }), null)
  assert.equal(bearerOf({}), null)
})

test('serveDoor: one request per connection over a real socket, replied from the seat route, closed when no seat is left', async t => {
  const home = await mkdtemp(join(tmpdir(), 'door-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const seen = []
  const route = http.createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk }).on('end', () => { seen.push([request.method, request.url, request.headers.authorization, body]); response.end('{"ok":false,"status":503,"code":"not_paired"}\n') })
  })
  await new Promise(resolve => route.listen(0, '127.0.0.1', resolve))
  t.after(() => route.close())
  const address = join(home, '.bellteam', 'approval-box-door.sock')
  const door = new Door(async () => 1)
  let emptied = false
  const server = await serveDoor(door, address, () => { emptied = true }, 20, 2000)
  t.after(() => server.close())
  const ask = line => new Promise((resolve, reject) => {
    const socket = net.connect(address); let out = ''
    socket.setEncoding('utf8').on('data', chunk => { out += chunk }).on('end', () => resolve(out)).on('error', reject)
    socket.end(`${line}\n`)
  })
  assert.deepEqual(JSON.parse(await ask(JSON.stringify({ bellteam_door: 'register', session: 's', port: route.address().port, authorization: BEARER, alive: ['x'] }))), { ok: true })
  assert.equal(await ask('{"method":"GET","path":"/status","body":{}}'), '{"ok":false,"status":503,"code":"not_paired"}\n')
  assert.deepEqual(seen, [['POST', '/api/seat-mcp/approval-box/local', BEARER, '{"method":"GET","path":"/status","body":{}}']])
  // the stub says "absent" every sweep: two sweeps later the door closes itself
  for (let i = 0; i < 50 && !emptied; i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(emptied, true)
})

test('the hook on a real host process: writes the program under ~/.bellteam, starts the door, registers from env only, and a request comes through', { timeout: 30_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'door-home-'))
  const route = http.createServer((request, response) => { request.resume().on('end', () => response.end(`{"ok":true,"auth":"${request.headers.authorization === BEARER}"}\n`)) })
  await new Promise(resolve => route.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    route.close()
    await promisify(execFile)('pkill', ['-f', home]).catch(() => {})
    await rm(home, { recursive: true, force: true })
  })
  const { command } = doorHook('0.70.100', '0.70.100').post_launch
  const env = { PATH: process.env.PATH, HOME: home, AITERM_SESSION_ID: 'bot-x-1', AITERM_SEAT_FORWARD_PORT: String(route.address().port),
    AITERM_SESSION_ALIVE: JSON.stringify([process.execPath, '-e', 'process.exit(0)']), BELLTEAM_MCP_TOKEN: 'A'.repeat(43) }
  const run = () => new Promise((resolve, reject) => { const child = spawn(process.execPath, command.slice(1), { env, stdio: 'ignore' }); child.on('exit', resolve).on('error', reject) })
  assert.equal(await run(), 0)
  const file = join(home, '.bellteam', 'approval-box-door.mjs')
  assert.equal(await readFile(file, 'utf8'), command[4], 'the program text is written as shipped')
  const address = doorAddress('linux', home, 'x')
  const ask = line => new Promise((resolve, reject) => { const socket = net.connect(address); let out = ''; socket.setEncoding('utf8').on('data', c => { out += c }).on('end', () => resolve(out)).on('error', reject); socket.end(`${line}\n`) })
  assert.equal(await ask('{"method":"GET","path":"/status","body":{}}'), '{"ok":true,"auth":"true"}\n')
  assert.equal(await run(), 0, 'a second launch finds the door and registers again')
  const record = await readFile(join(home, '.bellteam', 'approval-box-door.log'), 'utf8')
  assert.match(record, /serve start/)
  assert.match(record, /register sent \(event unknown\) session=bot-x-1/)
  assert.equal(record.includes('A'.repeat(43)), false, 'the record never holds a bearer or the seat token')
  // no bearer in the hook env: nothing registers, nothing fails
  assert.equal(await registerFromEnv({ ...env, BELLTEAM_MCP_TOKEN: '' }, address, 1), false)
})

test('a registration that is skipped says which field was missing, and the record is capped', async t => {
  const home = await mkdtemp(join(tmpdir(), 'door-log-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const file = join(home, 'door.log'), lines = []
  const log = line => { lines.push(line); writeLog(line, file) }
  assert.equal(await registerFromEnv({ AITERM_HOOK_EVENT: 'launch', AITERM_SESSION_ID: 's', AITERM_SESSION_ALIVE: '[]' }, join(home, 'x.sock'), 1, log), false)
  assert.match(lines[0], /^register skipped \(launch\): missing or invalid AITERM_SEAT_FORWARD_PORT, bearer, AITERM_SESSION_ALIVE$/)
  assert.match(await readFile(file, 'utf8'), /missing or invalid AITERM_SEAT_FORWARD_PORT/)
  writeLog('x'.repeat(70 * 1024), file); writeLog('after', file)
  assert.ok((await readFile(file, 'utf8')).length < 1024, 'a record over 64 KiB starts over')
})

test('a seat dropped by its alive check says so with the exit codes seen', async () => {
  const lines = [], codes = [1, 1]
  const door = new Door(async () => codes.shift(), fetch, line => lines.push(line))
  door.register('s', 40001, BEARER, ['x'])
  await door.sweep(); await door.sweep()
  assert.deepEqual(lines.map(line => line.replace(/ alive=.*/, '')), ['registered session=s port=40001', 'sweep session=s alive-exit=1 misses=1', 'dropped session=s: alive check exited 1 twice in a row'])
  assert.equal(lines.join('\n').includes('A'.repeat(43)), false)
})

test('Windows starts the door through WMI (outside the ssh session job), with every path quoted', () => {
  const [command, args] = windowsStart("C:\\Users\\o'brien\\node.exe", 'C:\\Users\\o\'brien\\.bellteam\\approval-box-door.mjs', "C:\\Users\\o'brien")
  assert.equal(command, 'powershell.exe')
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand'])
  const script = Buffer.from(args[3], 'base64').toString('utf16le')
  assert.match(script, /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/)
  assert.ok(script.includes(`CommandLine='"C:\\Users\\o''brien\\node.exe" "C:\\Users\\o''brien\\.bellteam\\approval-box-door.mjs" serve'`), script)
  assert.ok(script.includes(`CurrentDirectory='C:\\Users\\o''brien'`))
})

test('the alive check runs with the environment the hook registered (a door started outside the session has none)', async () => {
  const seen = []
  const door = new Door(async (alive, env) => { seen.push(env); return 0 })
  const base = { bellteam_door: 'register', session: 's', port: 40001, authorization: BEARER, alive: ['x'] }
  assert.deepEqual(JSON.parse(await door.handle(JSON.stringify({ ...base, env: { TEMP: 'C:\\Temp', TMP: 'C:\\Temp' } }))), { ok: true })
  await door.sweep()
  assert.deepEqual(seen[0], { TEMP: 'C:\\Temp', TMP: 'C:\\Temp' })
  await door.handle(JSON.stringify({ ...base, env: { TEMP: 5 } })); await door.sweep()
  assert.equal(seen[1], undefined, 'a malformed env is ignored, not trusted')
})
