import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAuthMediationService } from '../src/auth-mediation/service.mjs'
import { authMediationTools, authMediationToolHandlers } from '../src/auth-mediation/mcp.mjs'
import { createAuthMediationDispatcher } from '../src/auth-mediation-dispatcher.mjs'
import { validateAuthMediationRequest, validateAuthMediationEffect, validateAuthMediationEffectResult, validateAuthMediationControl,
  validateAuthMediationReady, AUTH_MEDIATION_STATE_COMPATIBILITY } from '../src/auth-mediation-protocol.mjs'

const generation = 'builtin:fixture'
const SECRET = 'sk-live-abcdef123456'
const bad = fn => assert.throws(fn, error => /AUTH_MEDIATION/u.test(error.code))
const ok = JSON.stringify({ fields: [{ label: 'API_KEY', value: SECRET }] })

async function fixture({ token = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'auth-med-'))
  await writeFile(join(dir, 'policy.json'), JSON.stringify({ version: 2, vault: 'v', cache_seconds: 3600, admins: ['bot-admin'],
    bots: { 'bot-a': { grants: [{ command: 'node app.mjs' }] } }, units: {}, stopped: [] }))
  let stored = token ? 'tok' : null, ran = null
  const service = createAuthMediationService({ policyPath: join(dir, 'policy.json'), auditPath: join(dir, 'audit.jsonl'),
    realpath: async p => p,
    runOp: async args => { assert.equal(args[2], 'node app.mjs'); return ok } })
  const effect = async (method, params) => {
    if (method === 'members.roots') return { roots: { 'bot-a': '/srv/bellteam/bots/bot-a', 'bot-admin': '/srv/bellteam/bots/bot-admin' } }
    if (method === 'secret.get') return stored === null ? { unavailable: true } : { value: stored }
    if (method === 'secret.put') { stored = params.value; return { stored: true } }
    if (method === 'secret.erase') { stored = null; return { erased: true } }
    ran = params; return { exitCode: 0, stdout: 'key=' + SECRET, stderr: '', truncated: false, timedOut: false }
  }
  const dispatcher = createAuthMediationDispatcher({ core: service })
  await dispatcher.control('initialize', { generation, mode: 'bootstrap' }); await dispatcher.control('resume', {})
  const call = (method, params) => dispatcher.dispatch(method, params, { generation }, effect)
  return { call, dir, ran: () => ran, stored: () => stored }
}

test('protocol shapes are exact', () => {
  validateAuthMediationRequest('resolve', { command: ['a'], cwd: '/x', via: 'container-socket' }, { generation })
  validateAuthMediationRequest('resolve', { command: ['a'], cwd: '/x', via: 'mcp', botId: 'bot-a', args: ['--x'], timeoutSec: 60 }, { generation })
  bad(() => validateAuthMediationRequest('resolve', { command: ['a'], cwd: '/x', via: 'mcp' }, { generation }))
  bad(() => validateAuthMediationRequest('resolve', { command: [], cwd: '/x', via: 'host-socket' }, { generation }))
  bad(() => validateAuthMediationRequest('resolve', { command: ['a'], cwd: 'x', via: 'host-socket' }, { generation }))
  bad(() => validateAuthMediationRequest('resolve', { command: ['a'], cwd: '/x', via: 'host-socket', extra: 1 }, { generation }))
  validateAuthMediationRequest('admin', { botId: 'bot-a', verb: 'drop' }, { generation }) // an unknown verb is answered by the child, not rejected as unavailable
  bad(() => validateAuthMediationRequest('admin', { botId: 'bot-a', verb: 'Drop;' }, { generation }))
  validateAuthMediationEffect('seat.run', { botId: 'bot-a', cwd: '/x', argv: ['a'], env: { A: '1' }, timeoutMs: 1000 })
  bad(() => validateAuthMediationEffect('seat.run', { botId: 'bot-a', cwd: '/x', argv: ['a'], env: { A: '1' }, timeoutMs: 5 }))
  bad(() => validateAuthMediationEffect('secret.put', { value: '' }))
  validateAuthMediationEffectResult('secret.get', { unavailable: true }); bad(() => validateAuthMediationEffectResult('secret.get', { unavailable: false }))
  validateAuthMediationControl('initialize', { generation, mode: 'restore' }); bad(() => validateAuthMediationControl('stop', {}))
  validateAuthMediationReady({ versionId: null, protocolVersion: 1, stateCompatibility: AUTH_MEDIATION_STATE_COMPATIBILITY })
})

test('MCP path runs the one command, redacts the secret, audits without values', async () => {
  const f = await fixture()
  const r = await f.call('resolve', { command: ['node', 'app.mjs'], args: ['--flag'], cwd: '/srv/bellteam/bots/bot-a', via: 'mcp', botId: 'bot-a' })
  assert.equal(r.outcome, 'granted'); assert.equal(r.stdout, 'key=[redacted:API_KEY]'); assert.equal(r.exit_code, 0)
  assert.deepEqual(f.ran().argv, ['node', 'app.mjs', '--flag']); assert.deepEqual(f.ran().env, { API_KEY: SECRET })
  assert.ok(!(await readFile(join(f.dir, 'audit.jsonl'), 'utf8')).includes(SECRET))
  const denied = await f.call('resolve', { command: ['node', 'other.mjs'], cwd: '/srv/bellteam/bots/bot-a', via: 'mcp', botId: 'bot-a' })
  assert.equal(denied.outcome, 'denied')
})

test('container socket gets env back, identity from peer cwd; no token = not-registered until token.set', async () => {
  const f = await fixture({ token: false })
  const req = { command: ['node', 'app.mjs'], cwd: '/srv/bellteam/bots/bot-a', via: 'container-socket' }
  assert.deepEqual(await f.call('status', {}), { state: 'no-token' })
  const noToken = await (async () => { const g = createAuthMediationService({ policyPath: join(f.dir, 'policy.json'), auditPath: join(f.dir, 'a2.jsonl'), opExe: '/nonexistent' })
    return g.resolve(req, async (m) => m === 'members.roots' ? { roots: { 'bot-a': '/srv/bellteam/bots/bot-a' } } : { unavailable: true }) })()
  assert.equal(noToken.outcome, 'not-registered')
  assert.equal((await f.call('admin', { botId: 'bot-a', verb: 'token.set', args: { value: 'x' } })).outcome, 'denied'); assert.equal(f.stored(), null)
  assert.equal((await f.call('admin', { botId: 'bot-admin', verb: 'token.set', args: { value: 'tok2' } })).outcome, 'ok'); assert.equal(f.stored(), 'tok2')
  assert.deepEqual(await f.call('status', {}), { state: 'ready' })
  assert.deepEqual((await f.call('resolve', req)).env, { API_KEY: SECRET })
  assert.equal((await f.call('admin', { botId: 'bot-admin', verb: 'token.clear' })).outcome, 'ok'); assert.equal(f.stored(), null)
})

test('MCP tool: one fixed command, the seat Bot ID comes from the seat, not the arguments', async () => {
  const [tool] = authMediationTools((properties, required = []) => ({ type: 'object', properties, required }))
  assert.equal(tool.name, 'auth_exec'); assert.deepEqual(tool.inputSchema.required, ['command'])
  let seen
  await authMediationToolHandlers.auth_exec({ args: { command: ['a'], botId: 'bot-evil', timeout_sec: 5 }, from: 'bot-a', authExec: input => { seen = input } })
  assert.deepEqual(seen, { botId: 'bot-a', command: ['a'], args: [], cwd: undefined, timeoutSec: 5 })
})

test('admin by peer cwd: the Bot is the registered root that contains it', async () => {
  const f = await fixture()
  assert.equal((await f.call('admin', { cwd: '/srv/bellteam/bots/bot-admin/tools', verb: 'show' })).outcome, 'ok')
  assert.equal((await f.call('admin', { cwd: '/srv/bellteam/bots/bot-a', verb: 'show' })).outcome, 'denied')
  assert.equal((await f.call('admin', { cwd: '/tmp', verb: 'show' })).outcome, 'denied')
  bad(() => validateAuthMediationRequest('admin', { verb: 'show', cwd: '/x', botId: 'bot-a' }, { generation }))
  bad(() => validateAuthMediationRequest('admin', { verb: 'show' }, { generation }))
})

test('unknown admin verb: denied for a non-admin, a plain error for an admin', async () => {
  const f = await fixture()
  assert.equal((await f.call('admin', { botId: 'bot-a', verb: 'drop' })).outcome, 'denied')
  assert.deepEqual(await f.call('admin', { botId: 'bot-admin', verb: 'drop' }), { outcome: 'error', error: 'Unknown verb.' })
})

test('first administrators come from the environment and are not lost when policy.json has none', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'auth-adm-'))
  await writeFile(join(dir, 'policy.json'), JSON.stringify({ version: 2, vault: 'v', admins: [], bots: {}, units: {}, stopped: [] }))
  const service = createAuthMediationService({ policyPath: join(dir, 'policy.json'), auditPath: join(dir, 'a.jsonl'), firstAdmins: ['bot-first'], realpath: async p => p })
  const effect = async m => m === 'members.roots' ? { roots: { 'bot-first': '/srv/bellteam/bots/bot-first', 'bot-x': '/srv/bellteam/bots/bot-x' } } : { unavailable: true }
  assert.equal((await service.admin({ cwd: '/srv/bellteam/bots/bot-first', verb: 'show' }, effect)).outcome, 'ok')
  assert.equal((await service.admin({ cwd: '/srv/bellteam/bots/bot-x', verb: 'show' }, effect)).outcome, 'denied')
  assert.equal((await service.admin({ botId: 'bot-first', verb: 'grant', args: { bot: 'bot-x', command: 'c' } }, effect)).outcome, 'ok')
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'policy.json'), 'utf8')).bots['bot-x'].grants, [{ command: 'c' }])
})

test('audit verb: admins read the last lines, a non-admin is denied, nothing but audit lines come back', async () => {
  const f = await fixture()
  await f.call('resolve', { command: ['node', 'app.mjs'], cwd: '/srv/bellteam/bots/bot-a', via: 'container-socket' })
  await f.call('resolve', { command: ['node', 'nope'], cwd: '/srv/bellteam/bots/bot-a', via: 'container-socket' })
  await new Promise(r => setTimeout(r, 20))
  const out = await f.call('admin', { botId: 'bot-admin', verb: 'audit', args: { last: 1 } })
  assert.equal(out.outcome, 'ok'); assert.equal(out.lines.length, 1); assert.equal(JSON.parse(out.lines[0]).outcome, 'denied')
  assert.ok(!JSON.stringify(out).includes(SECRET))
  assert.equal((await f.call('admin', { botId: 'bot-a', verb: 'audit' })).outcome, 'denied')
  assert.equal((await f.call('admin', { botId: 'bot-admin', verb: 'audit' })).lines.length, 3) // two requests and the non-admin's denied attempt
})
