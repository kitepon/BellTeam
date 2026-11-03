import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModuleUpdateExecutor } from '../src/update-module-executor.mjs'

const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' })
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'module-install-ledger-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const release = { componentId: 'notifications', sourceCommit: 'b'.repeat(40), versionId: 'c'.repeat(64),
    platform: { os: 'linux', arch: 'amd64' }, changes: [], artifact: { kind: 'archive' },
    compatibility: { nodeMajor: 26, parentProtocol: 2, stateSchema: 2, containerUpdate: null } }
  const selection = { catalogSha256: 'd'.repeat(64), expiresAt: '2099-01-01T00:00:00Z', release }
  const calls = { plans: 0, starts: [], gets: [], applies: 0 }
  let installed = false, current = { version: 'a'.repeat(40), sourceCommit: 'a'.repeat(40), digest: null, origin: 'builtin' }
  let hostPlan, hostPhase = 'completed', prepareError = null
  const ledger = async () => JSON.parse(await readFile(join(root, 'state/update-ledger/ledger.json')))
  const result = id => ({ requestId: id, planId: hostPlan.planId, target: release, admission: 'accepted', phase: hostPhase,
    execution: hostPhase === 'completed' ? 'succeeded' : 'pending', verification: hostPhase === 'completed' ? 'succeeded' : 'pending', error: null })
  const moduleHost = {
    moduleInstallCapabilities: async () => ({ supported: true }),
    async planModuleInstall(input) {
      calls.plans++; hostPlan = { schema: 'bellteam.host-update.plan.v1', ...input, target: release,
        expiresAt: '2099-01-01T00:00:00Z', impact: { containerRestart: false } }
      return hostPlan
    },
    async startModuleInstall(input) {
      calls.starts.push(input)
      const saved = await ledger(), progress = saved.operations[0].steps[0]
      assert.equal(progress.installRequestId, input.requestId)
      assert.equal(progress.installIssued, true)
      assert.notEqual(input.requestId, saved.operations[0].operation.requestId)
      return { ...result(input.requestId), phase: 'applying', execution: 'pending', verification: 'pending' }
    },
    async operation(id) { calls.gets.push(id); if (hostPhase === 'completed') installed = true; return result(id) },
  }
  const adapters = { notifications: {
    current: () => ({ ...current }), available: () => true, canRollback: () => true,
    async prepare() { if (!installed) throw missing(); if (prepareError) throw prepareError },
    async apply(step) { assert(installed); calls.applies++; current = { ...step.target, origin: 'release' } },
  } }
  const options = { root, catalog: { select: async () => selection }, adapters, moduleHost }
  const executor = await createModuleUpdateExecutor(options)
  t.after(() => executor.close())
  return { root, executor, options, moduleHost, calls, ledger,
    plan: () => executor.plan({ scope: 'component', componentId: 'notifications' }),
    request: plan => ({ requestId: randomUUID(), planId: plan.planId, confirmContainerRestart: false }),
    setPhase: value => { hostPhase = value }, setInstalled: value => { installed = value }, setPrepareError: value => { prepareError = value },
  }
}
async function done(executor, id) {
  for (let n = 0; n < 500; n++) {
    const result = await executor.operation(id)
    if (['completed', 'failed', 'unknown'].includes(result.phase)) return result
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.fail('worker did not finish')
}

test('install step persists its separate UUID before issuance and only verified Host completion permits replace', async t => {
  const f = await fixture(t), plan = await f.plan()
  assert.equal(f.calls.starts.length, 0)
  const request = f.request(plan)
  assert.equal((await f.executor.start(request)).admission, 'accepted')
  const result = await done(f.executor, request.requestId)
  assert.equal(result.phase, 'completed')
  assert.equal(f.calls.starts.length, 1); assert.equal(f.calls.applies, 1)
  assert(f.calls.gets.every(id => id === f.calls.starts[0].requestId))
  assert.equal((await f.ledger()).operations[0].steps[0].installPhase, 'completed')
  await f.executor.start(request)
  assert.equal(f.calls.starts.length, 1)
})

test('install capability and fixed Host target are required before public plan admission', async t => {
  const f = await fixture(t)
  f.moduleHost.moduleInstallCapabilities = async () => ({ supported: false })
  await assert.rejects(f.plan(), { code: 'HOST_MODULE_INSTALL_UNAVAILABLE' })
  assert.equal(f.calls.plans, 0)
  f.moduleHost.moduleInstallCapabilities = async () => ({ supported: true })
  const plan = f.moduleHost.planModuleInstall
  f.moduleHost.planModuleInstall = async input => ({ ...await plan(input), target: { componentId: 'members' } })
  await assert.rejects(f.plan(), { code: 'UPDATE_HOST_RESPONSE_INVALID' })
  assert.equal(f.calls.starts.length, 0)
})

test('untrusted installed bytes are never repaired by issuing an installer', async t => {
  const f = await fixture(t)
  f.setInstalled(true); f.setPrepareError(Object.assign(new Error(), { code: 'GATEWAY_RELEASE_CONTENT_CHANGED' }))
  await assert.rejects(f.plan(), { code: 'GATEWAY_RELEASE_CONTENT_CHANGED' })
  assert.equal(f.calls.plans, 0); assert.equal(f.calls.starts.length, 0)
})

test('unknown install survives reconstruction and is queried with its saved UUID without replay or automatic replace', async t => {
  const f = await fixture(t), plan = await f.plan(), request = f.request(plan)
  const start = f.moduleHost.startModuleInstall
  f.moduleHost.startModuleInstall = async input => { await start(input); throw Object.assign(new Error(), { code: 'HOST_UPDATE_UNAVAILABLE', outcome: 'unknown' }) }
  await f.executor.start(request)
  assert.equal((await done(f.executor, request.requestId)).phase, 'unknown')
  await f.executor.close()
  const recovered = await createModuleUpdateExecutor(f.options)
  t.after(() => recovered.close())
  assert.equal((await recovered.start(request)).phase, 'unknown')
  assert.equal((await recovered.operation(request.requestId)).phase, 'unknown')
  assert.equal(f.calls.starts.length, 1); assert.equal(f.calls.applies, 0)
  assert.equal((await f.ledger()).operations[0].steps[0].installPhase, 'completed')
})

test('Host unknown blocks subsequent plans and never reaches replace', async t => {
  const f = await fixture(t), plan = await f.plan(), request = f.request(plan)
  f.setPhase('unknown')
  await f.executor.start(request)
  assert.equal((await done(f.executor, request.requestId)).phase, 'unknown')
  await assert.rejects(f.plan(), { code: 'MODULE_EXCHANGE_BUSY' })
  assert.equal(f.calls.applies, 0); assert.equal(f.calls.starts.length, 1)
})

test('Host success still requires the real reader to validate the installed descriptor', async t => {
  const f = await fixture(t), plan = await f.plan(), request = f.request(plan)
  f.setPrepareError(Object.assign(new Error(), { code: 'GATEWAY_RELEASE_CONTENT_CHANGED' }))
  await f.executor.start(request)
  const result = await done(f.executor, request.requestId)
  assert.equal(result.phase, 'failed'); assert.equal(result.error.code, 'GATEWAY_RELEASE_CONTENT_CHANGED')
  assert.equal(f.calls.applies, 0)
})

test('an archive disappearing after an already-prepared plan does not authorize a new Host install plan', async t => {
  const f = await fixture(t); f.setInstalled(true)
  const plan = await f.plan(); f.setInstalled(false)
  await assert.rejects(f.executor.start(f.request(plan)), { code: 'UPDATE_INSTALL_PLAN_EXPIRED' })
  assert.equal(f.calls.plans, 0); assert.equal(f.calls.starts.length, 0)
})
