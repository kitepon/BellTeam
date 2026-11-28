import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAuthMediationProcess } from '../src/auth-mediation-process.mjs'
import { createAuthMediationParentChannel } from '../src/auth-mediation-ipc.mjs'
import { createAuthMediationEffects } from '../src/auth-mediation-effects.mjs'
import { createAuthMediationFacade } from '../src/auth-mediation-facade.mjs'

test('the module process is accepted by the shared module framework (component name, controller shape)', () => {
  const controller = createAuthMediationProcess({ root: '/tmp/x', onEffect: async () => null, spawnProcess() {} })
  for (const name of ['start', 'request', 'close', 'snapshot']) assert.equal(typeof controller[name], 'function', name)
})

test('the real child, driven through the parent channel, effects and facade: ready, status, unknown caller refused before any secret read', async t => {
  const state = await mkdtemp(join(tmpdir(), 'auth-med-parent-'))
  t.after(() => rm(state, { recursive: true, force: true }))
  await writeFile(join(state, 'policy.json'), JSON.stringify({ version: 2, vault: 'v', cache_seconds: 3600, admins: [], bots: {}, units: {}, stopped: [] }), { mode: 0o600 })
  const entry = fileURLToPath(new URL('../src/auth-mediation-entry.mjs', import.meta.url))
  const child = fork(entry, ['builtin'], { env: { PATH: process.env.PATH, AUTH_MEDIATION_STATE: state }, serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  t.after(() => child.kill('SIGKILL'))
  const bots = { listForClient: async () => [{ id: 'bot-a' }], projectPath: id => `/srv/bellteam/bots/${id}` }
  const asked = []
  const credentials = { current: async scope => { asked.push(scope); return null } }
  const generation = 'builtin:parent-test'
  const channel = createAuthMediationParentChannel(child, { generation, onEffect: createAuthMediationEffects({ bots, credentials }) })
  await channel.control('initialize', { generation, mode: 'bootstrap' })
  await channel.ready
  await channel.control('resume', {})
  assert.equal((await channel.request('status', {})).state, 'no-token')
  asked.length = 0 // status itself looks for the token; the refusals below must not
  const facade = createAuthMediationFacade({ controller: { request: (method, params) => channel.request(method, params) }, bots })
  const refused = await facade.containerSocket({ command: ['gh', 'release', 'list'], cwd: '/somewhere/else' })
  assert.equal(refused.outcome, 'unknown-caller')
  assert.equal(refused.env, undefined)
  const unregistered = await facade.exec({ botId: 'bot-a', command: ['gh', 'release', 'list'] })
  assert.ok(['denied', 'not-registered', 'unknown-caller'].includes(unregistered.outcome), unregistered.outcome)
  assert.equal(asked.length, 0, 'no secret read for a refused request')
  await channel.control('quiesce', {})
  await channel.control('exit', {})
})
