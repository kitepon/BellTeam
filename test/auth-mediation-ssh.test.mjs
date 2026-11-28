import assert from 'node:assert/strict'
import { createPublicKey, verify } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAuthCore } from '../src/auth-mediation/core.mjs'
import { createItemCache } from '../src/auth-mediation/items.mjs'
import { emptyPolicy } from '../src/auth-mediation/policy.mjs'
import { sshIdentity, sshSign } from '../src/auth-mediation/sshkey.mjs'
import { validateAuthMediationRequest } from '../src/auth-mediation-protocol.mjs'
import { relayAnswer } from '../src/auth-mediation-relay.mjs'

const AUTH = new URL('../scripts/auth-mediation/auth', import.meta.url).pathname
const dir = await mkdtemp(join(tmpdir(), 'ssh-test-'))
const gen = (name, ...args) => { const r = spawnSync('ssh-keygen', ['-q', '-N', '', '-C', name, '-f', join(dir, name), ...args]); assert.equal(r.status, 0, String(r.stderr)) }
const keys = {}
for (const [name, args] of Object.entries({ ed: ['-t', 'ed25519'], rsa: ['-t', 'rsa', '-b', '2048'], p256: ['-t', 'ecdsa', '-b', '256'], p384: ['-t', 'ecdsa', '-b', '384'], p521: ['-t', 'ecdsa', '-b', '521'] })) { gen(name, ...args); keys[name] = { ssh_key: await readFile(join(dir, name), 'utf8') } }
test.after(() => rm(dir, { recursive: true, force: true }))

const reader = buf => { let at = 0; const string = () => { const n = buf.readUInt32BE(at); at += 4; const out = buf.subarray(at, at + n); at += n; return out }; return { string } }
const unsignedPad = (b, size) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; const t = b.subarray(i); return Buffer.concat([Buffer.alloc(Math.max(0, size - t.length)), t]) }
// Independent check: the signature blob verifies under the public key blob the module published.
function check(blobB64, sigB64, data, flags = 0) {
  const pub = reader(Buffer.from(blobB64, 'base64')), type = pub.string().toString(), sig = reader(Buffer.from(sigB64, 'base64')), alg = sig.string().toString(), raw = sig.string()
  if (type === 'ssh-ed25519') { assert.equal(alg, 'ssh-ed25519'); return verify(null, data, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pub.string().toString('base64url') }, format: 'jwk' }), raw) }
  if (type === 'ssh-rsa') { const e = pub.string(), n = pub.string(); assert.equal(alg, flags & 4 ? 'rsa-sha2-512' : 'rsa-sha2-256')
    return verify(flags & 4 ? 'sha512' : 'sha256', data, createPublicKey({ key: { kty: 'RSA', n: n.toString('base64url'), e: e.toString('base64url') }, format: 'jwk' }), raw) }
  const curve = pub.string().toString(), point = pub.string(), size = { nistp256: 32, nistp384: 48, nistp521: 66 }[curve], r = reader(raw); assert.equal(alg, type)
  const p1363 = Buffer.concat([unsignedPad(r.string(), size), unsignedPad(r.string(), size)])
  return verify({ nistp256: 'sha256', nistp384: 'sha384', nistp521: 'sha512' }[curve], data, { key: createPublicKey({ key: { kty: 'EC', crv: { nistp256: 'P-256', nistp384: 'P-384', nistp521: 'P-521' }[curve], x: point.subarray(1, 1 + size).toString('base64url'), y: point.subarray(1 + size).toString('base64url') }, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, p1363)
}

test('ssh: ed25519, rsa and ecdsa keys sign inside the module; every signature verifies under the published public key (rsa only with sha2 flags)', () => {
  const data = Buffer.from('session-bytes-to-sign')
  for (const name of ['ed', 'p256', 'p384', 'p521']) assert.ok(check(sshIdentity(keys[name]), sshSign(keys[name], data.toString('base64'), 0), data), name)
  assert.ok(check(sshIdentity(keys.rsa), sshSign(keys.rsa, data.toString('base64'), 2), data, 2)); assert.ok(check(sshIdentity(keys.rsa), sshSign(keys.rsa, data.toString('base64'), 4), data, 4))
  assert.throws(() => sshSign(keys.rsa, data.toString('base64'), 0), /SSHKEY_REFUSED/u) // the old sha1 ssh-rsa is refused
  assert.equal(sshIdentity(keys.ed), (await_pub('ed')))
})
function await_pub(name) { return Buffer.from(spawnSync('cat', [join(dir, name + '.pub')]).stdout.toString().split(' ')[1], 'base64').toString('base64') }

test('ssh: an encrypted key, a non-OpenSSH text, a missing field or bad input is refused with nothing said', () => {
  const r = spawnSync('ssh-keygen', ['-q', '-N', 'secret', '-t', 'ed25519', '-f', join(dir, 'enc')]); assert.equal(r.status, 0)
  const enc = { ssh_key: spawnSync('cat', [join(dir, 'enc')]).stdout.toString() }
  for (const fields of [enc, { ssh_key: 'nope' }, {}, { ssh_key: keys.ed.ssh_key.replace(/\n[^\n]*\n/u, '\nAAAA\n') }]) assert.throws(() => sshIdentity(fields), /SSHKEY_REFUSED|Error/u)
  assert.throws(() => sshSign(keys.ed, 'not base64!'), /SSHKEY_REFUSED/u)
})

test('ssh: same grants as the other key uses ("sshkey <name> sign" for list and sign); the audit records the action, never the data or the signature', async () => {
  const lines = [], UNIT = '/home/kite/ssh'
  const store = { policy: { ...emptyPolicy(), vault: 'v', units: { [UNIT]: { grants: [{ command: 'sshkey ed sign' }] } } }, read: async () => structuredClone(store.policy) }
  const core = createAuthCore({ store, items: createItemCache({ runOp: async args => JSON.stringify({ fields: [{ label: 'ssh_key', value: keys.ed.ssh_key }] }) }), audit: l => lines.push(l), roots: () => ({}) })
  const call = (action, extra = {}) => core.keyuse({ action, name: 'ed', via: 'host-socket', cwd: UNIT, unit: UNIT, ...extra })
  const id = await call('ssh-identity'); assert.equal(id.outcome, 'granted'); assert.equal(id.data, sshIdentity(keys.ed))
  const data = Buffer.from('x').toString('base64'), s = await call('ssh-sign', { data, flags: 0 }); assert.equal(s.outcome, 'granted')
  assert.equal((await core.keyuse({ action: 'ssh-sign', name: 'other', data, via: 'host-socket', cwd: UNIT, unit: UNIT })).outcome, 'denied')
  await new Promise(r => setImmediate(r)); const log = JSON.stringify(lines)
  assert.ok(!log.includes(data) && !log.includes(s.data) && !log.includes('BEGIN OPENSSH'))
  assert.deepEqual(lines.map(l => [l.action, l.item, l.outcome]), [['ssh-identity', 'sshkey ed sign', 'granted'], ['ssh-sign', 'sshkey ed sign', 'granted'], ['ssh-sign', 'sshkey other sign', 'denied']])
})

test('ssh: relay and protocol carry ssh-identity (no data) and ssh-sign (data, flags) for every transport', async () => {
  const seen = []; const facade = { keyuse: async p => (seen.push(p), { outcome: 'granted', data: 'AA==' }) }
  await relayAnswer({ via: 'host-socket', peer: null, request: { op: 'ssh-identity', name: 'ed', cwd: '/c' } }, facade)
  await relayAnswer({ via: 'caller-socket', unit: '/x/a.sock', peer: null, request: { op: 'ssh-sign', name: 'ed', data: 'AA==', flags: 2 } }, facade)
  assert.deepEqual(seen, [{ action: 'ssh-identity', name: 'ed', via: 'host-socket', cwd: '/c', unit: '/c' }, { action: 'ssh-sign', name: 'ed', data: 'AA==', flags: 2, via: 'caller-socket', unit: '/x/a.sock' }])
  const ctx = { generation: 'g1' }
  assert.doesNotThrow(() => validateAuthMediationRequest('keyuse', { action: 'ssh-identity', name: 'ed', via: 'host-socket', cwd: '/c', unit: '/c' }, ctx))
  for (const bad of [{ action: 'sign', name: 'a', unit: '/c' }, { action: 'ssh-sign', name: 'a', data: 'AA==', flags: 9, unit: '/c' }]) assert.throws(() => validateAuthMediationRequest('keyuse', bad, ctx), /AUTH_MEDIATION_INVALID/u)
})

// End to end with the real OpenSSH tools: the client's per-run agent forwards to a module stand-in that holds the keys.
async function fakeModule() {
  const sock = join(dir, 'm.sock'), seen = []
  const server = createServer(c => { let buf = ''; c.on('data', d => { buf += d; if (!buf.includes('\n')) return; const req = JSON.parse(buf); seen.push(req.op); const k = keys[req.name]
    const data = req.op === 'ssh-identity' ? sshIdentity(k) : sshSign(k, req.data, req.flags); c.end(JSON.stringify({ outcome: 'granted', data }) + '\n') }) })
  await new Promise(r => server.listen(sock, r)); return { sock, seen, close: () => server.close() }
}
// Async on purpose: the module stand-in lives in this process, so a blocking spawn would starve it.
const sh = (env, script) => new Promise(resolve => { const c = spawn('python3', [AUTH, 'ssh', ...script], { env: { ...process.env, ...env } }); let stdout = '', stderr = ''; c.stdout.on('data', d => { stdout += d }); c.stderr.on('data', d => { stderr += d }); c.on('close', status => resolve({ status, stdout, stderr })) })

test('auth ssh: ssh-add -L lists the module\'s key by name; ssh-keygen -Y sign through the agent makes a signature OpenSSH itself accepts; the socket is gone afterwards', async () => {
  const m = await fakeModule(), env = { AUTH_SOCK: m.sock }
  try {
    const list = await sh(env, ['ed,rsa', '--', 'ssh-add', '-L']); assert.equal(list.status, 0, list.stderr)
    assert.match(list.stdout, /^ssh-ed25519 \S+ ed$/mu); assert.match(list.stdout, /^ssh-rsa \S+ rsa$/mu)
    for (const name of ['ed', 'rsa', 'p256']) {
      await writeFile(join(dir, name + '.msg'), 'hello ' + name)
      const signed = await sh(env, [name, '--', 'ssh-keygen', '-Y', 'sign', '-n', 'file', '-f', join(dir, name + '.pub'), '-U', join(dir, name + '.msg')]); assert.equal(signed.status, 0, signed.stderr)
      const ok = spawnSync('ssh-keygen', ['-Y', 'check-novalidate', '-n', 'file', '-s', join(dir, name + '.msg.sig')], { input: 'hello ' + name }); assert.equal(ok.status, 0, String(ok.stderr))
    }
    assert.ok(m.seen.includes('ssh-sign') && m.seen.includes('ssh-identity'))
    const gone = await sh(env, ['ed', '--', 'sh', '-c', 'echo $SSH_AUTH_SOCK']); assert.equal(spawnSync('ls', [gone.stdout.trim()]).status !== 0, true)
  } finally { m.close() }
})
