import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createUpdateCenter } from '../src/update-center.mjs'
import { createUpdateJobReader } from '../src/update-job-reader.mjs'
import { createModuleUpdateCatalog } from '../src/update-module-catalog.mjs'
import { createModuleUpdateExecutor } from '../src/update-module-executor.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'
import { runtimeComponentIds, validateUpdateRequest, validateUpdateResponse } from '../src/update-center-contract.mjs'
import { validUpdateInventory } from '../web/update-center.js'

const sha = character => character.repeat(64)
const record = (jobId, kind, moduleId, updatedAtNs) => ({ schema: 'bellteam.update-job.v1', jobId, idempotencyKey: jobId, kind,
  target: { catalogSha256: null, moduleId, versionId: 'builtin' }, state: 'queued', reason: null,
  transitions: [{ state: 'queued', atNs: updatedAtNs }], updatedAtNs })
const moduleJob = record('11111111-1111-4111-8111-111111111111', 'module', 'usage', '2')
const runtimeJob = record('22222222-2222-4222-8222-222222222222', 'runtime', 'runtime-codex', '3')
const runtimeRelease = id => {
  const url = `https://github.com/kitepon/BellTeam/releases/download/updates-20261108T000000Z/${id}-${'b'.repeat(40)}-linux-amd64.tar.gz`
  return { componentId: id, sourceCommit: 'b'.repeat(40), versionId: sha('b'), platform: { os: 'linux', arch: 'amd64' },
    artifact: { kind: 'archive', archive: { url, sha256: sha('b'), bytes: 10 }, bundle: { url: url + '.sigstore.json', sha256: sha('d'), bytes: 10 }, signerCommit: 'c'.repeat(40) },
    compatibility: runtimeComponentIds.includes(id) ? { runtimeProtocol: 1, nodeMajor: 26, libc: 'glibc' }
      : { nodeMajor: 26, parentProtocol: 1, stateSchema: 1, containerUpdate: null }, changes: [] }
}
const selection = id => ({ schema: 'bellteam.update-catalog.selection.v1', catalogSha256: sha('c'), publishedAt: '2026-11-08T00:00:00Z',
  expiresAt: '2099-01-01T00:00:00Z', publication: { status: 'verified', checkedAt: '2026-11-08T00:00:00Z', error: null },
  release: ['web-gateway', ...runtimeComponentIds].includes(id) ? runtimeRelease(id) : null })

test('released readers see byte-identical updates without runtime=1; runtime rows and jobs need the opt-in', async t => {
  const client = jobs => ({ jobs: async () => ({ jobs: structuredClone(jobs) }), job: async () => structuredClone(moduleJob) })
  const capture = async () => ({ generation: null, components: Object.fromEntries(runtimeComponentIds.map(id => [id, { origin: 'builtin' }])) })
  const make = jobs => createUpdateCenter({ jobReader: createUpdateJobReader({ module: client(jobs), container: client([]) }), captureRuntime: capture })
  const center = make([runtimeJob, moduleJob]), released = make([moduleJob])
  const server = createBellTeamServer({ bots: new Map(), rooms: {}, store: { watch: () => () => {} }, transport: {},
    authorize: async () => true, updateCenter: center, writeLog() {} })
  await server.startMessageWatch(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}/api/updates`
  const stable = value => JSON.stringify({ ...value, observedAt: null })

  const plain = await (await fetch(base)).json()
  assert.equal(stable(plain), stable(await released.snapshot()))
  assert.ok(validUpdateInventory(plain))
  assert.deepEqual(plain.jobs, [moduleJob])
  assert.ok(plain.components.every(component => !runtimeComponentIds.includes(component.id) && !('runtimeApplication' in component)))
  assert.deepEqual(await (await fetch(base + '/jobs')).json(), { jobs: [moduleJob] })

  const opted = await (await fetch(base + '?runtime=1')).json()
  validateUpdateResponse('inventory', opted)
  assert.deepEqual(opted.jobs, [runtimeJob, moduleJob])
  assert.deepEqual(opted.components.filter(component => runtimeComponentIds.includes(component.id)).map(component => [component.id, component.current.version, component.runtimeApplication]),
    runtimeComponentIds.map(id => [id, 'builtin', { generationId: null, policy: 'next_launch' }]))
  assert.deepEqual(await (await fetch(base + '/jobs?runtime=1')).json(), { jobs: [runtimeJob, moduleJob] })

  // SSE has no opt-in: released apps listen on the same stream.
  const reader = (await fetch(base.replace('/updates', '/events'))).body.getReader(); await reader.read()
  center.notify()
  const event = JSON.parse(new TextDecoder().decode((await reader.read()).value).match(/data: (.+)/u)[1])
  assert.deepEqual(event.jobs, [moduleJob])
  await reader.cancel()
})

test('opted-in rows project builtin and release captures against the runtime catalog', async () => {
  const generation = sha('e')
  const capture = async () => ({ generation, components: Object.fromEntries(runtimeComponentIds.map(id => [id,
    id === 'runtime-codex' ? { origin: 'release', archiveSha256: sha('b') } : { origin: 'builtin' }])) })
  const catalog = createModuleUpdateCatalog({ client: { catalog: async id => selection(id) } })
  const rows = async captureRuntime => (await createUpdateCenter({ moduleCatalog: catalog, captureRuntime }).snapshot({ runtime: true }))
    .components.filter(component => runtimeComponentIds.includes(component.id))
  const value = await rows(capture)
  const codex = value.find(component => component.id === 'runtime-codex'), claude = value.find(component => component.id === 'runtime-claude-code')
  assert.deepEqual(codex.current, { version: sha('b'), sourceCommit: null, digest: 'sha256:' + sha('b'), origin: 'release' })
  assert.equal(codex.comparison.state, 'up_to_date')
  assert.deepEqual(claude.current, { version: 'builtin', sourceCommit: null, digest: null, origin: 'builtin' })
  assert.deepEqual([claude.published.digest, claude.comparison.state], ['sha256:' + sha('b'), 'update_available'])
  assert.deepEqual(claude.runtimeApplication, { generationId: generation, policy: 'next_launch' })
  // Without an executor nothing is offered.
  assert.deepEqual(claude.capability, { supported: false, reason: 'UPDATE_EXECUTOR_UNAVAILABLE' })
  const broken = await rows(async () => { throw Object.assign(new Error('RUNTIME_BINDING_UNAVAILABLE'), { code: 'RUNTIME_BINDING_UNAVAILABLE' }) })
  assert.ok(broken.every(component => component.current === null && component.availability.reason === 'RUNTIME_BINDING_UNAVAILABLE'
    && component.capability.supported === false && component.runtimeApplication.generationId === null))
})

async function runtimeFixture(t, { fail = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-update-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const jobs = new Map(), calls = []
  const plans = new Map()
  const moduleHost = {
    moduleInstallCapabilities: async () => ({ supported: true, reason: null }),
    async planModuleInstall(input) { calls.push(['plan', input.componentId]); plans.set(input.planId, input)
      return { schema: 'bellteam.host-update.plan.v1', planId: input.planId, catalogSha256: input.catalogSha256,
        target: runtimeRelease(input.componentId), impact: { containerRestart: false }, expiresAt: '2099-01-01T00:00:00Z' } },
    async admitJob(input) { calls.push(['admit', input.kind, input.target.moduleId])
      const value = { schema: 'bellteam.update-job.v1', ...input, state: 'queued', reason: null, transitions: [{ state: 'queued', atNs: '1' }], updatedAtNs: '1' }
      jobs.set(input.jobId, value); return structuredClone(value) },
    async startModuleInstall({ requestId, planId }) {
      calls.push(['start', requestId])
      // The updater worker drives the runtime job to its terminal state.
      Object.assign(jobs.get(requestId), fail ? { state: 'failed', reason: { code: fail, message: fail } } : { state: 'ready' })
      return this.operation(requestId, planId)
    },
    async operation(requestId) {
      const job = jobs.get(requestId), plan = [...plans.values()][0]
      return { requestId, planId: plan.planId, target: runtimeRelease(plan.componentId), admission: 'accepted',
        phase: job.state === 'ready' ? 'completed' : 'failed', execution: job.state === 'ready' ? 'succeeded' : 'failed',
        verification: job.state === 'ready' ? 'succeeded' : 'failed' }
    },
    async job(id) { return structuredClone(jobs.get(id)) },
    async updateJob() { calls.push(['updateJob']); throw new Error('the worker owns runtime completion') },
  }
  const exchanges = []
  const adapter = { current: () => ({ version: 'a'.repeat(40), sourceCommit: 'a'.repeat(40), digest: null, origin: 'builtin' }), available: () => true,
    prepare: async () => {}, apply: async () => { exchanges.push('apply') }, canRollback: () => true }
  const catalog = createModuleUpdateCatalog({ client: { catalog: async id => selection(id) } })
  const executor = await createModuleUpdateExecutor({ root, catalog, moduleHost, adapters: { 'web-gateway': adapter } })
  t.after(() => executor.close())
  const inventory = { components: [{ id: 'runtime-codex', current: { version: 'builtin', sourceCommit: null, digest: null, origin: 'builtin' } }] }
  return { executor, calls, exchanges, inventory }
}

test('CLI and Throughline runtimes are never offered or planned: every runtime updates with the body image (Owner 2026-11-08)', async t => {
  const f = await runtimeFixture(t)
  const notice = { state: 'unavailable', code: 'X', message: 'x' }
  for (const id of ['runtime-codex', 'runtime-claude-code', 'runtime-throughline']) {
    const row = { id, current: { version: 'builtin', sourceCommit: null, digest: null, origin: 'builtin' },
      published: { version: sha('b'), sourceCommit: 'b'.repeat(40), digest: 'sha256:' + sha('b'), origin: 'published' },
      comparison: { state: 'update_available', reason: null }, capability: { supported: false, reason: 'UPDATE_EXECUTOR_UNAVAILABLE' }, availability: { available: true, reason: null } }
    const offered = await f.executor.snapshot({ components: [row], plans: [], operation: null, previousOperation: null, notice })
    assert.deepEqual(offered.components[0].capability, { supported: false, reason: 'RUNTIME_BODY_IMAGE_ONLY' })
    await assert.rejects(f.executor.plan({ scope: 'component', componentId: id }, { components: [row] }), { code: 'RUNTIME_BODY_IMAGE_ONLY' })
  }
  assert.deepEqual(f.calls, [])
})
test('a runtime plan saved before the body-only rule is refused at start before catalog, staging or admission', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-saved-plan-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const published = { version: sha('b'), sourceCommit: 'b'.repeat(40), digest: 'sha256:' + sha('b'), origin: 'published' }
  const current = { version: 'builtin', sourceCommit: null, digest: null, origin: 'builtin' }
  const plan = { planId: randomUUID(), scope: 'component', componentId: 'runtime-codex', action: 'update', expiresAt: '2099-01-01T00:00:00Z',
    targets: [{ componentId: 'runtime-codex', current, published }], compatibility: { compatible: true, reason: null },
    impact: { containerRestart: false, description: '次回起動から適用します。' }, capability: { supported: true, reason: null } }
  const step = { componentId: 'runtime-codex', from: current, target: published, release: runtimeRelease('runtime-codex'), catalogSha256: sha('c'),
    installPlan: { planId: randomUUID(), expiresAt: '2099-01-01T00:00:00Z' } }
  await mkdir(join(root, 'state/update-ledger'), { recursive: true, mode: 0o700 })
  await writeFile(join(root, 'state/update-ledger/ledger.json'), JSON.stringify({ schema: 'bellteam.module-update.ledger.v1',
    plans: [{ plan, steps: [step], hostPlan: null }], operations: [] }) + '\n', { mode: 0o600 })
  const calls = []
  const moduleHost = new Proxy({}, { get: (_, name) => name === 'then' ? undefined : (...args) => { calls.push(name); return Promise.resolve(null) } })
  const catalog = { select: async id => { calls.push(['select', id]); return selection(id) }, checkCatalog: async () => {} }
  const executor = await createModuleUpdateExecutor({ root, catalog, moduleHost, adapters: {} })
  t.after(() => executor.close())
  await assert.rejects(executor.start({ planId: plan.planId, requestId: randomUUID(), confirmContainerRestart: false }), { code: 'RUNTIME_BODY_IMAGE_ONLY' })
  assert.deepEqual(calls, [])
})
test('an all plan keeps its module and container steps only', async t => {
  const f = await runtimeFixture(t)
  const plan = await f.executor.plan({ scope: 'all' }, null)
  assert.deepEqual(plan.targets.map(target => target.componentId), ['web-gateway'])
})

test('runtime-aiterm-mcp is never offered or planned: it updates only with the body image (Elegg 2026-11-08)', async t => {
  const f = await runtimeFixture(t)
  const notice = { state: 'unavailable', code: 'X', message: 'x' }
  const row = { id: 'runtime-aiterm-mcp', current: { version: 'builtin', sourceCommit: null, digest: null, origin: 'builtin' },
    published: { version: sha('b'), sourceCommit: 'b'.repeat(40), digest: 'sha256:' + sha('b'), origin: 'published' },
    comparison: { state: 'update_available', reason: null }, capability: { supported: false, reason: 'UPDATE_EXECUTOR_UNAVAILABLE' }, availability: { available: true, reason: null } }
  const offered = await f.executor.snapshot({ components: [row], plans: [], operation: null, previousOperation: null, notice })
  assert.deepEqual(offered.components[0].capability, { supported: false, reason: 'RUNTIME_COHABITATION_UNSUPPORTED' })
  await assert.rejects(f.executor.plan({ scope: 'component', componentId: 'runtime-aiterm-mcp' }, { components: [row] }), { code: 'RUNTIME_COHABITATION_UNSUPPORTED' })
  assert.deepEqual(f.calls, [])
})
