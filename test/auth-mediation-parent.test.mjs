import test from 'node:test'
import assert from 'node:assert/strict'
import { createAuthMediationEffects, AUTH_MEDIATION_TOKEN_SCOPE, SEAT_RUN_OUTPUT_LIMIT } from '../src/auth-mediation-effects.mjs'
import { createAuthMediationFacade } from '../src/auth-mediation-facade.mjs'
import { createSeatProcessRunner } from '../src/seat-process.mjs'
import { validateAuthMediationEffect, validateAuthMediationEffectResult } from '../src/auth-mediation-protocol.mjs'
import { bellTeamTools, callBellTeamTool } from '../src/mcp-tools.mjs'

const bots = { listForClient: async () => [{ id: 'bot-aaa' }, { id: 'Bad Id' }, { id: 'bot-bbb' }], projectPath: id => `/srv/bellteam/bots/${id}` }
const credentialsFake = (state = {}) => ({
  async current(scope) { state.scope = scope; return state.handle ? { handle: state.handle, available: state.available !== false } : null },
  async withResolved(handle, context, use) { state.context = context; if (state.lost) throw Object.assign(new Error('x'), { code: 'SECRET_SOURCE_UNAVAILABLE' }); return use('token-value') },
  async put(scope, value) { state.put = [scope, value] }, async erase(scope) { state.erased = scope },
})

test('members.roots lists only valid Bot ids with their project roots, and the result passes the child protocol', async () => {
  const effect = createAuthMediationEffects({ bots })
  const value = await effect('members.roots', {})
  assert.deepEqual(value, { roots: { 'bot-aaa': '/srv/bellteam/bots/bot-aaa', 'bot-bbb': '/srv/bellteam/bots/bot-bbb' } })
  validateAuthMediationEffectResult('members.roots', value)
})

test('secret.*: only the fixed scope, the value only inside the callback, a lost source is "unavailable", never a throw', async () => {
  const state = { handle: 'h1' }
  const effect = createAuthMediationEffects({ bots, credentials: credentialsFake(state) })
  const got = await effect('secret.get', {})
  assert.deepEqual(got, { value: 'token-value' })
  assert.deepEqual(state.scope, AUTH_MEDIATION_TOKEN_SCOPE)
  assert.deepEqual(state.context, { ...AUTH_MEDIATION_TOKEN_SCOPE, memberId: null })
  validateAuthMediationEffectResult('secret.get', got)
  state.lost = true
  assert.deepEqual(await effect('secret.get', {}), { unavailable: true })
  assert.deepEqual(await createAuthMediationEffects({ bots, credentials: credentialsFake({}) })('secret.get', {}), { unavailable: true })
  assert.deepEqual(await createAuthMediationEffects({ bots, credentials: credentialsFake({ handle: 'h', available: false }) })('secret.get', {}), { unavailable: true })
  assert.deepEqual(await effect('secret.put', { value: 'new' }), { stored: true })
  assert.deepEqual(state.put, [AUTH_MEDIATION_TOKEN_SCOPE, 'new'])
  assert.deepEqual(await effect('secret.erase', {}), { erased: true })
  assert.deepEqual(state.erased, AUTH_MEDIATION_TOKEN_SCOPE)
  await assert.rejects(createAuthMediationEffects({ bots })('secret.put', { value: 'x' }), { code: 'AUTH_MEDIATION_SECRET_UNAVAILABLE' })
  await assert.rejects(effect('nope', {}), { code: 'AUTH_MEDIATION_EFFECT_INVALID' })
})

test('seat.run: the Bot root is the runner project, the secret goes as secretEnv only, a cwd below the root uses env --chdir, outputs are capped, timeouts answer timedOut', async () => {
  const calls = []
  const seatRunner = project => async (command, args, options) => { calls.push({ project, command, args, options }); return { stdout: 'x'.repeat(SEAT_RUN_OUTPUT_LIMIT + 5), stderr: 'e', code: 3, signal: null } }
  const effect = createAuthMediationEffects({ bots, seatRunner })
  const root = '/srv/bellteam/bots/bot-aaa'
  const direct = await effect('seat.run', { botId: 'bot-aaa', cwd: root, argv: ['gh', 'release', 'list'], env: { GH_TOKEN: 'secret-xyz' }, timeoutMs: 5000 })
  assert.deepEqual(calls[0].project, root)
  assert.equal(calls[0].command, 'gh'); assert.deepEqual(calls[0].args, ['release', 'list'])
  assert.deepEqual(calls[0].options.secretEnv, { GH_TOKEN: 'secret-xyz' })
  assert.ok(!JSON.stringify([calls[0].command, calls[0].args]).includes('secret-xyz'))
  assert.equal(direct.exitCode, 3); assert.equal(direct.stdout.length, SEAT_RUN_OUTPUT_LIMIT); assert.equal(direct.truncated, true); assert.equal(direct.timedOut, false)
  validateAuthMediationEffectResult('seat.run', direct)
  await effect('seat.run', { botId: 'bot-aaa', cwd: root + '/sub', argv: ['ls'], env: {}, timeoutMs: 1000 })
  assert.equal(calls[1].command, '/usr/bin/env'); assert.deepEqual(calls[1].args, ['--chdir=' + root + '/sub', '--', 'ls']); assert.equal(calls[1].options.secretEnv, undefined)
  for (const bad of [{ cwd: '/etc', argv: ['ls'] }, { cwd: root + '/sub', argv: ['A=b'] }, { cwd: root + 'x/sub', argv: ['ls'] }])
    await assert.rejects(effect('seat.run', { botId: 'bot-aaa', env: {}, timeoutMs: 1000, ...bad }), { code: 'AUTH_MEDIATION_SEAT_RUN_REFUSED' })
  const aborting = createAuthMediationEffects({ bots, seatRunner: () => async () => { throw Object.assign(new Error('ABORT_ERR'), { name: 'AbortError', code: 'ABORT_ERR' }) } })
  assert.deepEqual(await aborting('seat.run', { botId: 'bot-aaa', cwd: root, argv: ['sleep'], env: {}, timeoutMs: 1000 }), { exitCode: null, stdout: '', stderr: '', truncated: false, timedOut: true })
  const big = createAuthMediationEffects({ bots, seatRunner: () => async () => { throw Object.assign(new Error('x'), { code: 'SEAT_BUFFER_EXCEEDED' }) } })
  assert.equal((await big('seat.run', { botId: 'bot-aaa', cwd: root, argv: ['yes'], env: {}, timeoutMs: 1000 })).truncated, true)
})

test('the effect parameters the parent builds pass the child protocol validators', () => {
  validateAuthMediationEffect('seat.run', { botId: 'bot-aaa', cwd: '/srv/bellteam/bots/bot-aaa', argv: ['gh'], env: { GH_TOKEN: 'x' }, timeoutMs: 1000 })
  validateAuthMediationEffect('secret.put', { value: 'x' })
})

test('facade: the MCP path fills the Bot root as cwd, the sockets pass the facts, and a dead child answers outcome error, never a throw', async () => {
  const seen = []
  const facade = createAuthMediationFacade({ controller: { request: async (method, params) => { seen.push([method, params]); return { outcome: 'granted', env: { A: 'b' } } } }, bots })
  await facade.exec({ botId: 'bot-aaa', command: ['gh'], args: ['x'], timeoutSec: 30 })
  assert.deepEqual(seen[0], ['resolve', { command: ['gh'], args: ['x'], cwd: '/srv/bellteam/bots/bot-aaa', via: 'mcp', botId: 'bot-aaa', timeoutSec: 30 }])
  await facade.exec({ botId: 'bot-aaa', command: ['gh'], cwd: '/srv/bellteam/bots/bot-aaa/sub' })
  assert.equal(seen[1][1].cwd, '/srv/bellteam/bots/bot-aaa/sub'); assert.ok(!Object.hasOwn(seen[1][1], 'timeoutSec'))
  await facade.containerSocket({ command: ['gh'], cwd: '/srv/bellteam/bots/bot-aaa' })
  assert.deepEqual(seen[2], ['resolve', { command: ['gh'], args: [], cwd: '/srv/bellteam/bots/bot-aaa', via: 'container-socket' }])
  await facade.hostSocket({ command: ['deploy'], cwd: '/home/kite/app' })
  assert.deepEqual(seen[3][1], { command: ['deploy'], args: [], cwd: '/home/kite/app', via: 'host-socket', unit: '/home/kite/app' })
  await facade.admin({ botId: 'bot-aaa', verb: 'show' })
  assert.deepEqual(seen[4], ['admin', { botId: 'bot-aaa', verb: 'show' }])
  const dead = createAuthMediationFacade({ controller: { request: async () => { throw Object.assign(new Error('AUTH_MEDIATION_UNAVAILABLE'), { code: 'AUTH_MEDIATION_UNAVAILABLE' }) } }, bots })
  assert.deepEqual(await dead.exec({ botId: 'bot-aaa', command: ['gh'] }), { outcome: 'error', error: 'the authentication module is not running' })
  assert.deepEqual(await dead.status(), { state: 'unavailable' })
  const bad = createAuthMediationFacade({ controller: { request: async () => { throw Object.assign(new Error('AUTH_MEDIATION_INVALID'), { code: 'AUTH_MEDIATION_INVALID' }) } }, bots })
  assert.equal((await bad.exec({ botId: 'bot-aaa', command: [] })).error, 'request invalid')
})

test('seat.run through the real runner and sudo: value arrives in the environment, cwd applies, the secret is in no argv', { skip: process.getuid?.() !== 1000 }, async () => {
  const effect = createAuthMediationEffects({ bots: { ...bots, projectPath: () => '/tmp' }, seatRunner: project => createSeatProcessRunner(project, { environment: 'base' }) })
  const out = await effect('seat.run', { botId: 'bot-aaa', cwd: '/tmp', argv: ['sh', '-c', 'printf "%s|%s" "$SYNTH_TOKEN" "$(pwd)"'], env: { SYNTH_TOKEN: 'real-path-value' }, timeoutMs: 20000 })
  assert.deepEqual([out.exitCode, out.stdout, out.timedOut], [0, 'real-path-value|/tmp', false])
  const slow = await effect('seat.run', { botId: 'bot-aaa', cwd: '/tmp', argv: ['sleep', '30'], env: {}, timeoutMs: 1000 })
  assert.equal(slow.timedOut, true)
})

test('auth_exec is a seat MCP tool: listed, the Bot ID is the caller (never an argument), fork seats are refused, a module that is not serving answers outcome error', async () => {
  assert.ok(bellTeamTools.some(tool => tool.name === 'auth_exec'))
  const registry = { refresh: async () => {}, get: id => ({ id }) }
  const seen = []
  const facade = createAuthMediationFacade({ controller: { request: async (method, params) => (seen.push([method, params]), { outcome: 'granted', exit_code: 0, stdout: 'ok', stderr: '', truncated: false }) }, bots })
  const out = await callBellTeamTool({ registry, name: 'auth_exec', arguments: { command: ['gh', 'release', 'list'], args: ['-R', 'o/r'], timeout_sec: 30 }, from: 'bot-aaa', fork: false, authMediation: () => facade })
  assert.equal(out.outcome, 'granted')
  assert.deepEqual(seen[0], ['resolve', { command: ['gh', 'release', 'list'], args: ['-R', 'o/r'], cwd: '/srv/bellteam/bots/bot-aaa', via: 'mcp', botId: 'bot-aaa', timeoutSec: 30 }])
  await assert.rejects(callBellTeamTool({ registry, name: 'auth_exec', arguments: { command: ['gh'] }, from: 'bot-aaa', fork: true, authMediation: () => facade }), { code: 'AUTH_MEDIATION_NOT_ALLOWED' })
  assert.equal(seen.length, 1)
  assert.deepEqual(await callBellTeamTool({ registry, name: 'auth_exec', arguments: { command: ['gh'] }, from: 'bot-aaa', fork: false }), { outcome: 'error', error: 'the authentication module is not running' })
})
