import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const AUTH = new URL('../scripts/auth-mediation/auth', import.meta.url).pathname
const ADMIN = new URL('../scripts/auth-mediation/auth-admin', import.meta.url).pathname
const GRANT = new URL('../scripts/auth-mediation/grant', import.meta.url).pathname

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

test('auth-admin: entry-set (path and sha256 of the file), stop, token-set (value only on stdin), show prints the entry', async () => {
  const m = await fakeModule(req => req.verb === 'import' ? { outcome: 'ok', count: 3 } : { outcome: 'ok', policy: { bots: { 'bot-a': { grants: [{ command: 'x' }] } }, units: {}, stopped: ['y'] } })
  const env = { AUTH_SOCK: m.path }
  await run(ADMIN, ['entry-set', GRANT], env)
  assert.deepEqual(m.seen[0], { op: 'admin', verb: 'entry.set', args: { path: GRANT, sha256: createHash('sha256').update(await readFile(GRANT)).digest('hex') } })
  assert.notEqual((await run(ADMIN, ['grant', '--bot', 'bot-a', 'x'], env)).code, 0) // grant and revoke are the entry program's
  await run(ADMIN, ['token-set'], env, 'tok-123\n'); assert.deepEqual(m.seen[1], { op: 'admin', verb: 'token.set', args: { value: 'tok-123' } })
  const shown = await run(ADMIN, ['show'], env); assert.match(shown.out, /"bot": "bot-a"/u); assert.match(shown.out, /"stopped": "y"/u)
  assert.equal((await run(ADMIN, ['token-set'], env, '')).code, 1)
  m.close()
})

test('auth exec: a SIGTERM sent only to auth reaches a command that is still running after 1 s, and auth mirrors its exit code', async () => {
  const m = await fakeModule(() => ({ outcome: 'granted', env: {} }))
  const child = spawn(AUTH, ['exec', 'sh', '-c', 'trap "exit 7" TERM; while :; do sleep 0.1; done'], { env: { ...process.env, AUTH_SOCK: m.path } })
  const closed = new Promise(r => child.on('close', (code, signal) => r({ code, signal })))
  await new Promise(r => setTimeout(r, 700)); child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000)
  assert.deepEqual(await closed, { code: 7, signal: null }); clearTimeout(timer); m.close()
})

test('auth exec: a command killed by a signal makes auth die by the same signal', async () => {
  const m = await fakeModule(() => ({ outcome: 'granted', env: {} }))
  const out = await new Promise(resolve => { const c = spawn(AUTH, ['exec', 'sh', '-c', 'kill -TERM $$'], { env: { ...process.env, AUTH_SOCK: m.path } }); c.on('close', (code, signal) => resolve({ code, signal })) })
  assert.deepEqual(out, { code: null, signal: 'SIGTERM' }); m.close()
})

test('auth-admin audit prints the lines the module returns', async () => {
  const m = await fakeModule(() => ({ outcome: 'ok', lines: ['{"outcome":"granted"}', '{"outcome":"denied"}'] }))
  const out = await run(ADMIN, ['audit', '--last', '2'], { AUTH_SOCK: m.path })
  assert.deepEqual(m.seen[0], { op: 'admin', verb: 'audit', args: { last: 2 } }); assert.equal(out.out.trim().split('\n').length, 2); m.close()
})

test('auth exec: file:VAR becomes a 0600 file that is gone after the run; VAR labels pass as they are', async () => {
  const m = await fakeModule(() => ({ outcome: 'granted', env: { PLAIN: 'p', 'file:CRED_FILE': '{"k":1}' } }))
  const note = join(await mkdtemp(join(tmpdir(), 'cred-')), 'path')
  const out = await run(AUTH, ['exec', 'sh', '-c', 'echo "$PLAIN"; stat -c %a "$CRED_FILE"; cat "$CRED_FILE"; echo "$CRED_FILE" > ' + note], { AUTH_SOCK: m.path })
  assert.equal(out.code, 0); assert.deepEqual(out.out.trim().split('\n'), ['p', '600', '{"k":1}'])
  await assert.rejects(access((await readFile(note, 'utf8')).trim())); m.close()
})

test('auth exec: ssh-key is loaded into a per-run agent that is gone after the run', async t => {
  if (spawnSync('sh', ['-c', 'command -v ssh-agent && command -v ssh-add && command -v ssh-keygen']).status !== 0) return t.skip('ssh tools missing')
  const dir = await mkdtemp(join(tmpdir(), 'sshk-'))
  spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'k')])
  const m = await fakeModule(() => ({ outcome: 'granted', env: { 'ssh-key': spawnSync('cat', [join(dir, 'k')]).stdout.toString() } }))
  const note = join(dir, 'agent-path')
  const out = await run(AUTH, ['exec', 'sh', '-c', 'ssh-add -l | grep -c ED25519; echo "$SSH_AUTH_SOCK" > ' + note], { AUTH_SOCK: m.path })
  assert.equal(out.code, 0); assert.equal(out.out.trim(), '1')
  await assert.rejects(access((await readFile(note, 'utf8')).trim())); m.close()
})

test('grant entry program: refuses a grant without role/record/need/reason before the socket; sends the decision record with the admin request', async () => {
  const m = await fakeModule(() => ({ outcome: 'ok' }))
  const env = { AUTH_SOCK: m.path }
  const base = ['grant', '--bot', 'bot-a', '--cwd', '/srv/bellteam/bots/bot-a', 'gh release list']
  for (const args of [[...base, '--reason', 'r'], [...base, '--reason', 'r', '--role', 'x', '--record', 'y'], [...base, '--reason', ' ', '--role', 'x', '--record', 'y', '--need', 'standing'],
    [...base, '--reason', 'r', '--role', 'x', '--record', 'y', '--need', 'standing', '--until', '2099-01-01T00:00:00+00:00'], [...base, '--reason', 'r', '--role', 'x', '--record', 'y', '--need', 'one-off']])
    assert.notEqual((await run(GRANT, args, env)).code, 0, args.join(' '))
  assert.equal(m.seen.length, 0)
  const ok = await run(GRANT, [...base, '--reason', 'Epinel installs every Windows release', '--role', 'main adoption', '--record', 'chart a, b', '--need', 'standing'], env)
  assert.equal(ok.code, 0)
  const { decision, ...rest } = m.seen[0].args
  assert.deepEqual(m.seen[0].verb, 'grant'); assert.deepEqual(rest, { command: 'gh release list', bot: 'bot-a', cwd: '/srv/bellteam/bots/bot-a' })
  assert.deepEqual({ ...decision, id: 'x' }, { id: 'x', reason: 'Epinel installs every Windows release', role: 'main adoption', record: 'chart a, b', need: 'standing' })
  assert.match(ok.out, new RegExp(decision.id, 'u'))
  assert.equal((await run(GRANT, ['revoke', '--unit', '/home/kite/x', '--reason', 'retired', 'deploy'], env)).code, 0)
  assert.deepEqual(m.seen[1].args.decision.reason, 'retired'); assert.equal(m.seen[1].verb, 'revoke'); assert.equal(m.seen[1].args.unit, '/home/kite/x')
  m.close()
})

test('auth http: sends the request with the folder, prints only the response body, exit 22 for status >= 400, 1 and 2 for refusals', async () => {
  const m = await fakeModule(req => req.path === '/missing' ? { outcome: 'granted', status: 404, body: Buffer.from('nope').toString('base64') } : req.path === '/denied' ? { outcome: 'denied', error: 'no' }
    : req.path === '/bad' ? { outcome: 'error', error: 'The request failed.' } : { outcome: 'granted', status: 200, body: Buffer.from('{"a":1}').toString('base64') })
  const env = { AUTH_SOCK: m.path }
  const ok = await run(AUTH, ['http', 'stripe', 'post', '/v1/x', '-H', 'Accept: application/json', '--data', 'a=1'], env)
  assert.equal(ok.code, 0); assert.equal(ok.out, '{"a":1}')
  assert.deepEqual(m.seen[0], { op: 'http', name: 'stripe', method: 'POST', path: '/v1/x', cwd: process.cwd(), headers: { Accept: 'application/json' }, body: Buffer.from('a=1').toString('base64') })
  const missing = await run(AUTH, ['http', 'stripe', 'GET', '/missing'], env); assert.equal(missing.code, 22); assert.equal(missing.out, 'nope'); assert.match(missing.err, /HTTP 404/u)
  assert.equal((await run(AUTH, ['http', 'stripe', 'GET', '/denied'], env)).code, 1); assert.equal((await run(AUTH, ['http', 'stripe', 'GET', '/bad'], env)).code, 2)
  m.close()
})

test('auth sign: sends stdin as base64 with the folder, prints only the signature, 1 for a refusal and 2 for an error', async () => {
  const m = await fakeModule(req => req.name === 'no' ? { outcome: 'denied', error: 'no' } : req.name === 'bad' ? { outcome: 'error', error: 'Cannot sign.' } : { outcome: 'granted', data: 'c2ln' })
  const env = { AUTH_SOCK: m.path }
  const ok = await run(AUTH, ['sign', 'asc'], env, 'abc')
  assert.equal(ok.code, 0); assert.equal(ok.out.trim(), 'c2ln')
  assert.deepEqual(m.seen[0], { op: 'sign', name: 'asc', data: Buffer.from('abc').toString('base64'), cwd: process.cwd() })
  assert.equal((await run(AUTH, ['sign', 'no'], env, 'x')).code, 1); assert.equal((await run(AUTH, ['sign', 'bad'], env, 'x')).code, 2)
  m.close()
})

test('auth sign --digest: asks for sign-digest', async () => {
  const m = await fakeModule(() => ({ outcome: 'granted', data: 'c2ln' }))
  const r = await run(AUTH, ['sign', 'android', '--digest'], { AUTH_SOCK: m.path }, Buffer.alloc(32, 1))
  assert.equal(r.code, 0); assert.equal(m.seen[0].op, 'sign-digest'); assert.equal(m.seen[0].name, 'android')
  m.close()
})

test('auth mail send: sends the text from stdin with the options, prints the message id; the failure class goes to stderr', async () => {
  const m = await fakeModule(req => req.name === 'bad' ? { outcome: 'error', error: 'MAIL_UNKNOWN' } : { outcome: 'granted', message_id: '<1@x.yz>' })
  const env = { AUTH_SOCK: m.path }
  const ok = await run(AUTH, ['mail', 'send', 'contact', '--to', 'a@b.cd,e@f.gh', '--subject', 'Hi', '--from-name', 'Me', '--reply-to', 'r@s.tu'], env, 'body text')
  assert.equal(ok.code, 0); assert.equal(ok.out.trim(), '<1@x.yz>')
  assert.deepEqual(m.seen[0], { op: 'mail-send', name: 'contact', to: ['a@b.cd', 'e@f.gh'], subject: 'Hi', text: 'body text', cwd: process.cwd(), from_name: 'Me', reply_to: 'r@s.tu' })
  const bad = await run(AUTH, ['mail', 'send', 'bad', '--to', 'a@b.cd', '--subject', 'x'], env, 't'); assert.equal(bad.code, 2); assert.match(bad.err, /MAIL_UNKNOWN/u)
  m.close()
})
