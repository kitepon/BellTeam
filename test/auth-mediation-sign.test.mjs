import assert from 'node:assert/strict'
import { createHash, createHmac, generateKeyPairSync, sign, verify } from 'node:crypto'
import test from 'node:test'
import { createAuthCore } from '../src/auth-mediation/core.mjs'
import { createItemCache } from '../src/auth-mediation/items.mjs'
import { emptyPolicy } from '../src/auth-mediation/policy.mjs'
import { signData, signDigest } from '../src/auth-mediation/keyuse.mjs'
import { validateAuthMediationRequest } from '../src/auth-mediation-protocol.mjs'
import { relayAnswer } from '../src/auth-mediation-relay.mjs'

const UNIT = '/home/kite/asc-key', CWD = '/srv/bellteam/bots/bot-a'
const pem = key => key.export({ type: 'pkcs8', format: 'pem' })
const keys = { es256: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), es384: generateKeyPairSync('ec', { namedCurve: 'secp384r1' }), rs256: generateKeyPairSync('rsa', { modulusLength: 2048 }), ed: generateKeyPairSync('ed25519') }
const input = Buffer.from('eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJ4In0'), data = input.toString('base64')
const itemJson = fields => JSON.stringify({ fields: Object.entries(fields).map(([label, value]) => ({ label, value })) })

function setup(item, grants = ['signkey asc sign']) {
  const lines = []
  const store = { policy: { ...emptyPolicy(), vault: 'v', units: { [UNIT]: { grants: grants.map(command => ({ command })) } }, bots: { 'bot-a': { grants: grants.map(command => ({ command })) } } }, read: async () => structuredClone(store.policy) }
  const items = createItemCache({ runOp: async args => { if (args[2] !== 'signkey asc') throw new Error('x'); return itemJson(item) } })
  return { lines, core: createAuthCore({ store, items, audit: l => lines.push(l), roots: () => ({ 'bot-a': CWD }) }) }
}
const ask = (t, extra = {}) => t.core.keyuse({ action: 'sign', name: 'asc', data, via: 'host-socket', cwd: UNIT, unit: UNIT, ...extra })

test('sign: every algorithm gives a signature the public key (or the same secret) verifies; the answer is only the signature', async () => {
  const es = await ask(setup({ sign_key: pem(keys.es256.privateKey), sign_alg: 'ES256' }))
  assert.equal(es.outcome, 'granted'); assert.equal(Buffer.from(es.data, 'base64').length, 64) // raw r||s, the JWT form
  assert.ok(verify('sha256', input, { key: keys.es256.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(es.data, 'base64')))
  const es384 = await ask(setup({ sign_key: pem(keys.es384.privateKey), sign_alg: 'ES384' })); assert.equal(Buffer.from(es384.data, 'base64').length, 96)
  assert.ok(verify('sha384', input, { key: keys.es384.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(es384.data, 'base64')))
  const rs = await ask(setup({ sign_key: pem(keys.rs256.privateKey), sign_alg: 'RS256' })); assert.ok(verify('sha256', input, keys.rs256.publicKey, Buffer.from(rs.data, 'base64')))
  const ed = await ask(setup({ sign_key: pem(keys.ed.privateKey), sign_alg: 'EdDSA' })); assert.ok(verify(null, input, keys.ed.publicKey, Buffer.from(ed.data, 'base64')))
  const hs = await ask(setup({ sign_key: 'whsec_secret', sign_alg: 'HS256' })); assert.equal(hs.data, createHmac('sha256', 'whsec_secret').update(input).digest('base64'))
  assert.deepEqual(Object.keys(es).sort(), ['data', 'outcome'])
})

test('sign: the item fixes the algorithm and the key type must match it; a bad or missing key, algorithm or input is an error that tells nothing', async () => {
  for (const item of [{ sign_key: pem(keys.es384.privateKey), sign_alg: 'ES256' }, { sign_key: pem(keys.es256.privateKey), sign_alg: 'RS256' }, { sign_key: pem(keys.rs256.privateKey), sign_alg: 'EdDSA' },
    { sign_key: 'not a pem', sign_alg: 'ES256' }, { sign_key: pem(keys.es256.privateKey), sign_alg: 'none' }, { sign_key: pem(keys.es256.privateKey) }, { sign_alg: 'HS256' }])
    assert.deepEqual(await ask(setup(item)), { outcome: 'error', error: 'Cannot sign.' }, JSON.stringify(Object.keys(item)))
  assert.throws(() => signData({ sign_key: 'k', sign_alg: 'HS256' }, ''), /KEYUSE_REFUSED/u)
  assert.throws(() => signData({ sign_key: 'k', sign_alg: 'HS256' }, Buffer.alloc(3073).toString('base64')), /KEYUSE_REFUSED/u)
})

test('sign: same grants as the other uses: "signkey <name> sign"; a Bot caller is found by its folder; no grant or unknown caller is refused before any key read; the audit holds no data or signature', async () => {
  const item = { sign_key: 'k'.repeat(20), sign_alg: 'HS256' }
  assert.equal((await ask(setup(item, []))).outcome, 'denied'); assert.equal((await ask(setup(item, ['signkey asc wrap']))).outcome, 'denied')
  const t = setup(item)
  assert.equal((await t.core.keyuse({ action: 'sign', name: 'asc', data, via: 'container-socket', cwd: CWD })).outcome, 'granted')
  assert.equal((await t.core.keyuse({ action: 'sign', name: 'asc', data, via: 'container-socket', cwd: '/tmp' })).outcome, 'unknown-caller')
  assert.equal((await t.core.keyuse({ action: 'sign', name: 'asc', data, unit: UNIT })).outcome, 'granted') // a caller socket names its unit only
  await new Promise(r => setImmediate(r)); const log = JSON.stringify(t.lines)
  assert.ok(!log.includes(data) && !log.includes(createHmac('sha256', item.sign_key).update(input).digest('base64')) && !log.includes(item.sign_key))
  assert.deepEqual(t.lines.map(l => [l.item, l.outcome, l.via]), [['signkey asc sign', 'granted', 'container-socket'], ['signkey asc sign', 'unknown-caller', 'container-socket'], ['signkey asc sign', 'granted', 'caller-socket']])
})

test('sign-digest: an RS256 key signs a SHA-256 digest the caller computed: the result equals the normal signature over the message and verifies; other keys, algorithms and lengths are refused', async () => {
  const fields = { sign_key: pem(keys.rs256.privateKey), sign_alg: 'RS256' }, message = Buffer.from('a very large file stands in for this'), digest = createHash('sha256').update(message).digest()
  const sig = signDigest(fields, digest.toString('base64'))
  assert.equal(sig, sign('sha256', message, keys.rs256.privateKey).toString('base64')) // RSASSA-PKCS1-v1_5 is deterministic: same bytes as signing the message
  assert.ok(verify('sha256', message, keys.rs256.publicKey, Buffer.from(sig, 'base64')))
  for (const [f, d] of [[{ ...fields, sign_alg: 'ES256' }, digest], [{ sign_key: pem(keys.es256.privateKey), sign_alg: 'RS256' }, digest], [fields, Buffer.alloc(31)], [fields, Buffer.alloc(33)], [{ sign_alg: 'RS256' }, digest]])
    assert.throws(() => signDigest(f, d.toString('base64')), /KEYUSE_REFUSED/u)
  const t = setup(fields); const r = await t.core.keyuse({ action: 'sign-digest', name: 'asc', data: digest.toString('base64'), via: 'host-socket', cwd: UNIT, unit: UNIT })
  assert.deepEqual(r, { outcome: 'granted', data: sig })
})

test('relay: sign reaches the facade with the caller named by the transport; protocol takes it', async () => {
  const seen = []; const facade = { keyuse: async p => (seen.push(p), { outcome: 'granted', data: 'AA==' }) }
  const line = { op: 'sign', name: 'asc', data: 'AA==', cwd: '/claimed', unit: '/claimed' }
  await relayAnswer({ via: 'container-socket', peer: { uid: 1000, cwd: CWD }, request: line }, facade)
  await relayAnswer({ via: 'host-socket', peer: null, request: line }, facade)
  await relayAnswer({ via: 'caller-socket', unit: '/x/callers/a/a.sock', peer: null, request: line }, facade)
  assert.deepEqual(seen, [{ action: 'sign', name: 'asc', data: 'AA==', via: 'container-socket', cwd: CWD }, { action: 'sign', name: 'asc', data: 'AA==', via: 'host-socket', cwd: '/claimed', unit: '/claimed' },
    { action: 'sign', name: 'asc', data: 'AA==', via: 'caller-socket', unit: '/x/callers/a/a.sock' }])
  const ctx = { generation: 'g1' }
  assert.doesNotThrow(() => validateAuthMediationRequest('keyuse', { action: 'sign', name: 'asc', data: 'AA==', via: 'host-socket', cwd: UNIT, unit: UNIT }, ctx))
  assert.doesNotThrow(() => validateAuthMediationRequest('keyuse', { action: 'wrap', name: 'a', data: 'AA==', unit: UNIT }, ctx)) // the form the first train sent
  for (const bad of [{ action: 'sign', name: 'a', data: 'AA==', via: 'host-socket' }, { action: 'sign', name: 'a', data: 'AA==' }, { action: 'verify', name: 'a', data: 'AA==', unit: UNIT }])
    assert.throws(() => validateAuthMediationRequest('keyuse', bad, ctx), /AUTH_MEDIATION_INVALID/u)
})
