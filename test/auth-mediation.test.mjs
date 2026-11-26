import assert from 'node:assert/strict'
import test from 'node:test'
import { createAuthCore } from '../src/auth-mediation/core.mjs'
import { createItemCache } from '../src/auth-mediation/items.mjs'
import { emptyPolicy, importV1, authorize } from '../src/auth-mediation/policy.mjs'
import { envReturn, runEnv } from '../src/auth-mediation/env.mjs'
import { redact } from '../src/auth-mediation/redact.mjs'
import { botForCwd } from '../src/auth-mediation/identity.mjs'

const SECRET = 'sk-live-abcdef123456'
const itemJson = fields => JSON.stringify({ fields: Object.entries(fields).map(([label, value]) => ({ label, value })).concat({ label: 'notes', value: 'n', purpose: 'NOTES' }) })

function setup({ policy = {}, items = { 'gh release list -R a/b': { credential: SECRET }, 'node app.mjs': { API_KEY: SECRET, lower_case: 'x' }, 'bad env': { PATH: '/x' } } } = {}) {
  let clock = 1_000_000, calls = 0
  const store = { policy: { ...emptyPolicy(), vault: 'v', admins: ['bot-admin'], ...policy }, read: async () => structuredClone(store.policy), write: async p => { store.policy = p } }
  const cache = createItemCache({ now: () => clock, runOp: async args => { calls++; if (!items[args[2]]) throw new Error('x'); return itemJson(items[args[2]]) } })
  const lines = []
  const core = createAuthCore({ realpath: async p => ({ '/srv/bellteam/bots/bot-a/link': '/etc' })[p] ?? p, store, items: cache, audit: l => lines.push(l), roots: () => ({ 'bot-a': '/srv/bellteam/bots/bot-a', 'bot-b': '/srv/bellteam/bots/bot-b' }), now: () => new Date(clock) })
  return { core, store, lines, calls: () => calls, tick: ms => { clock += ms } }
}
const gh = { command: 'gh release list -R a/b' }

test('grant, ARGS never authorize, secrets never in audit', async () => {
  const t = setup({ policy: { bots: { 'bot-a': { grants: [gh] } } } })
  const ok = await t.core.resolve({ command: ['gh', 'release', 'list', '-R', 'a/b'], cwd: '/srv/bellteam/bots/bot-a', via: 'container-socket' })
  assert.deepEqual(ok.env, { GH_TOKEN: SECRET }); assert.equal(ok.cache, 'miss')
  assert.equal((await t.core.resolve({ command: ['gh', 'release', 'list', '-R', 'a/c'], cwd: '/srv/bellteam/bots/bot-a', via: 'container-socket' })).outcome, 'denied')
  assert.equal((await t.core.resolve({ command: ['gh', 'release', 'list', '-R', 'a/b'], cwd: '/srv/bellteam/bots/bot-b', via: 'container-socket' })).outcome, 'denied')
  assert.equal((await t.core.resolve({ command: ['gh'], cwd: '/tmp', via: 'container-socket' })).outcome, 'unknown-caller')
  await new Promise(r => setImmediate(r))
  assert.ok(!JSON.stringify(t.lines).includes(SECRET)); assert.equal(t.lines.length, 4)
})

test('no 1Password read before a refusal; cache hit, ttl, flush', async () => {
  const t = setup({ policy: { bots: { 'bot-a': { grants: [gh, { command: 'node app.mjs', expires: new Date(1_000_500).toISOString() }] } }, stopped: ['node app.mjs'] } })
  const a = { cwd: '/srv/bellteam/bots/bot-a', via: 'container-socket' }
  assert.equal((await t.core.resolve({ ...a, command: ['node', 'app.mjs'] })).outcome, 'stopped'); assert.equal(t.calls(), 0)
  await t.core.resolve({ ...a, command: gh.command.split(' ') }); const hit = await t.core.resolve({ ...a, command: gh.command.split(' ') })
  assert.equal(hit.cache, 'hit'); assert.equal(t.calls(), 1)
  t.tick(3_600_001); assert.equal((await t.core.resolve({ ...a, command: gh.command.split(' ') })).cache, 'miss')
  assert.equal(t.calls(), 2)
  assert.equal((await t.core.admin('bot-admin', 'flush', { command: gh.command })).outcome, 'ok')
  assert.equal((await t.core.resolve({ ...a, command: gh.command.split(' ') })).cache, 'miss')
  assert.equal(authorize(t.store.policy, { kind: 'bot', id: 'bot-a' }, 'node app.mjs', a.cwd, 1_000_501 ), 'stopped')
})

test('expiry, cwd-restricted grant, units, missing item', async () => {
  const p = { bots: { 'bot-a': { grants: [{ command: 'x', cwd: '/srv/bellteam/bots/bot-a/sub', expires: new Date(2000).toISOString() }] } }, units: { '/home/kite/app': { grants: [{ command: 'gh release list -R a/b' }] } } }
  assert.equal(authorize({ ...emptyPolicy(), ...p }, { kind: 'bot', id: 'bot-a' }, 'x', '/srv/bellteam/bots/bot-a/sub', 1000), 'granted')
  assert.equal(authorize({ ...emptyPolicy(), ...p }, { kind: 'bot', id: 'bot-a' }, 'x', '/srv/bellteam/bots/bot-a', 1000), 'denied')
  assert.equal(authorize({ ...emptyPolicy(), ...p }, { kind: 'bot', id: 'bot-a' }, 'x', '/srv/bellteam/bots/bot-a/sub', 3000), 'denied')
  const t = setup({ policy: p })
  assert.equal((await t.core.resolve({ command: ['gh', 'release', 'list', '-R', 'a/b'], cwd: '/x', unit: '/home/kite/app', via: 'host-socket' })).outcome, 'granted')
  assert.equal((await t.core.resolve({ command: ['gh', 'release', 'list', '-R', 'a/b'], cwd: '/x', unit: '/home/kite/other', via: 'host-socket' })).outcome, 'denied')
  const g = setup({ policy: { units: { '/u': { grants: [{ command: 'nothing here' }] } } } })
  assert.equal((await g.core.resolve({ command: ['nothing', 'here'], cwd: '/u', unit: '/u', via: 'host-socket' })).outcome, 'not-registered')
})

test('v1 import keeps every grant exactly as narrow (decision equivalence with the old broker rules)', async () => {
  const v1 = { vault: 'v', cache_seconds: 3600, stopped: ['s'], bots: [
    { root: '/srv/bellteam/bots/bot-a', grants: [['c1'], ['c2', '2099-01-01T00:00:00+00:00']] },
    { root: '/srv/bellteam/bots/bot-b/mailsort', grants: [['c3']] }] }
  const { policy, count } = importV1(emptyPolicy(), v1, 'container'); assert.equal(count, 3)
  const old = (cwd, name) => v1.bots.some(b => b.root === cwd && b.grants.some(g => g[0] === name)) && !v1.stopped.includes(name)
  const roots = { 'bot-a': '/srv/bellteam/bots/bot-a', 'bot-b': '/srv/bellteam/bots/bot-b' }
  for (const cwd of ['/srv/bellteam/bots/bot-a', '/srv/bellteam/bots/bot-b/mailsort', '/srv/bellteam/bots/bot-b', '/srv/bellteam/bots/bot-a/x'])
    for (const name of ['c1', 'c2', 'c3', 's', 'zz']) {
      const bot = botForCwd(roots, cwd)
      const now = authorize(policy, { kind: 'bot', id: bot }, name, cwd, Date.now()) === 'granted'
      // the old broker only knew the exact registered folders; the new one never grants anything the old one refused there
      if (now) assert.ok(old(cwd, name), cwd + ' ' + name)
      if (old(cwd, name)) assert.ok(now, cwd + ' ' + name)
    }
  const host = importV1(emptyPolicy(), { vault: 'v', bots: [{ root: '/home/kite/x', grants: [['d']] }] }, 'host')
  assert.deepEqual(host.policy.units['/home/kite/x'].grants, [{ command: 'd' }])
  assert.throws(() => importV1(emptyPolicy(), { bots: [{ root: '/etc', grants: [] }] }, 'container'), /AUTH_IMPORT_ROOT/u)
})

test('env rules: only VAR labels and credential leave, run path is strict; redaction', async () => {
  assert.deepEqual(envReturn({ A_B: '1', credential: ' t ', lower: 'x', 'file:F': 'p', 'ssh-key': 'k' }, 'gh'), { A_B: '1', GH_TOKEN: 't' })
  assert.deepEqual(runEnv({ API_KEY: SECRET }, 'node'), { API_KEY: SECRET })
  assert.equal(runEnv({ PATH: '/x' }, 'node'), null); assert.equal(runEnv({ BELLTEAM_X: '1' }, 'node'), null)
  assert.equal(runEnv({ 'file:F': 'p' }, 'node'), null); assert.equal(runEnv({}, 'node'), null)
  assert.equal(redact('token=' + SECRET + ' short=abc', { API_KEY: SECRET, S: 'abc' }), 'token=[redacted:API_KEY] short=abc')
  const t = setup({ policy: { bots: { 'bot-a': { grants: [{ command: 'bad env' }] } } } })
  assert.equal((await t.core.resolve({ command: ['bad', 'env'], botId: 'bot-a', cwd: '/srv/bellteam/bots/bot-a', via: 'mcp' })).outcome, 'error')
  assert.equal((await t.core.resolve({ command: ['bad', 'env'], cwd: '/srv/bellteam/bots/bot-a', via: 'container-socket' })).outcome, 'granted')
})

test('admin only for admins; grant, revoke, stop, resume change authorization and drop the cache', async () => {
  const t = setup()
  assert.equal((await t.core.admin('bot-a', 'grant', { bot: 'bot-a', command: 'x' })).outcome, 'denied')
  await t.core.admin('bot-admin', 'grant', { bot: 'bot-a', command: gh.command })
  const req = { command: gh.command.split(' '), botId: 'bot-a', cwd: '/srv/bellteam/bots/bot-a', via: 'mcp' }
  assert.equal((await t.core.resolve(req)).outcome, 'granted')
  await t.core.admin('bot-admin', 'stop', { command: gh.command }); assert.equal((await t.core.resolve(req)).outcome, 'stopped')
  await t.core.admin('bot-admin', 'resume', { command: gh.command }); assert.equal((await t.core.resolve(req)).outcome, 'granted')
  await t.core.admin('bot-admin', 'revoke', { bot: 'bot-a', command: gh.command }); assert.equal((await t.core.resolve(req)).outcome, 'denied')
})

test('MCP path: cwd must be clean and inside the Bot project, symlinks resolved', async () => {
  const t = setup({ policy: { bots: { 'bot-a': { grants: [{ command: 'node app.mjs' }] } } } })
  const ask = cwd => t.core.resolve({ command: ['node', 'app.mjs'], botId: 'bot-a', cwd, via: 'mcp' }).then(r => r.outcome)
  assert.equal(await ask('/srv/bellteam/bots/bot-a'), 'granted')
  assert.equal(await ask('/srv/bellteam/bots/bot-a/sub/deeper'), 'granted')
  for (const bad of ['/srv/bellteam/bots/bot-a/../bot-b', '/srv/bellteam/bots/bot-a/', '/srv/bellteam/bots//bot-a', '/srv/bellteam/bots/bot-ab', '/srv/bellteam/bots/bot-a/link', '/tmp'])
    assert.equal(await ask(bad), 'denied', bad)
  assert.equal(t.calls(), 1)
})
