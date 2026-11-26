import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const AUTH = new URL('../scripts/auth-mediation/auth', import.meta.url).pathname
const ADMIN = new URL('../scripts/auth-mediation/auth-admin', import.meta.url).pathname

async function fakeModule(reply) {
  const dir = await mkdtemp(join(tmpdir(), 'auth-sock-')), path = join(dir, 's.sock'), seen = []
  const server = createServer(c => { let buf = ''; c.on('data', d => { buf += d; if (buf.includes('\n')) { seen.push(JSON.parse(buf)); c.end(JSON.stringify(reply(seen.at(-1))) + '\n') } }) })
  await new Promise(r => server.listen(path, r))
  return { path, seen, close: () => server.close() }
}
const run = (file, args, env, input) => new Promise(resolve => {
  const child = spawn(file, args, { env: { ...process.env, ...env } }); let out = '', err = ''
  child.stdout.on('data', d => { out += d }); child.stderr.on('data', d => { err += d })
  child.on('close', code => resolve({ code, out, err })); child.stdin.end(input ?? '')
})

test('auth exec: sends command and cwd, appends ARGS after --, passes env, maps outcomes to exit codes', async () => {
  const m = await fakeModule(req => req.command[0] === 'sh' ? { outcome: 'granted', env: { FOO: 'bar' } } : { outcome: req.command[0] === 'bad' ? 'error' : 'denied', error: 'nope' })
  const ok = await run(AUTH, ['exec', 'sh', '-c', 'echo "$FOO $0 $1"', '--', 'a', 'b'], { AUTH_SOCK: m.path })
  assert.deepEqual(m.seen[0], { op: 'exec', command: ['sh', '-c', 'echo "$FOO $0 $1"'], cwd: process.cwd() })
  assert.equal(ok.code, 0); assert.equal(ok.out.trim(), 'bar a b')
  assert.equal((await run(AUTH, ['exec', 'other'], { AUTH_SOCK: m.path })).code, 1)
  assert.equal((await run(AUTH, ['exec', 'bad'], { AUTH_SOCK: m.path })).code, 2)
  m.close()
  const gone = await run(AUTH, ['exec', 'sh'], { AUTH_SOCK: m.path })
  assert.match(gone.err, /not running/u); assert.notEqual(gone.code, 0)
})

test('auth-admin: grant, stop, token-set (value only on stdin), import', async () => {
  const m = await fakeModule(req => req.verb === 'import' ? { outcome: 'ok', count: 3 } : { outcome: 'ok', policy: { bots: { 'bot-a': { grants: [{ command: 'x' }] } }, units: {}, stopped: ['y'] } })
  const env = { AUTH_SOCK: m.path }
  await run(ADMIN, ['grant', '--bot', 'bot-a', 'gh release list', '--cwd', '/srv/bellteam/bots/bot-a', '--until', '2099-01-01T00:00:00+00:00'], env)
  assert.deepEqual(m.seen[0], { op: 'admin', verb: 'grant', args: { command: 'gh release list', bot: 'bot-a', cwd: '/srv/bellteam/bots/bot-a', expires: '2099-01-01T00:00:00+00:00' } })
  await run(ADMIN, ['token-set'], env, 'tok-123\n'); assert.deepEqual(m.seen[1], { op: 'admin', verb: 'token.set', args: { value: 'tok-123' } })
  const shown = await run(ADMIN, ['show'], env); assert.match(shown.out, /"bot": "bot-a"/u); assert.match(shown.out, /"stopped": "y"/u)
  assert.equal((await run(ADMIN, ['token-set'], env, '')).code, 1)
  m.close()
})
