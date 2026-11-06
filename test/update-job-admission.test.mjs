import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createModuleUpdateExecutor } from '../src/update-module-executor.mjs'

async function fixture(t, { ids = ['web-gateway', 'notifications'], container = false, failApply = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'job-admission-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const jobs = new Map(), calls = [], changes = [], applied = [], current = new Map()
  let admitGate = null, failSecond = false, failReady = 0
  const host = {
    async admitJob(input) {
      calls.push(input)
      if (admitGate) await admitGate
      if (failSecond && jobs.size === 1) throw Object.assign(new Error('UNREADABLE'), { code: 'UNREADABLE', status: 503 })
      const previous = [...jobs.values()].find(job => job.idempotencyKey === input.idempotencyKey)
      if (previous) return structuredClone(previous)
      const record = { schema: 'bellteam.update-job.v1', ...input, state: 'queued', reason: null,
        transitions: [{ state: 'queued', atNs: '1' }], updatedAtNs: '1' }
      jobs.set(input.jobId, record)
      return structuredClone(record)
    },
    async job(id) { return structuredClone(jobs.get(id)) },
    async updateJob({ jobId, state, reason }) {
      if (state === 'ready' && failReady) { failReady--; throw Object.assign(new Error('UNREADABLE'), { code: 'UNREADABLE', status: 503 }) }
      const record = jobs.get(jobId)
      changes.push([record.target.moduleId, state]); record.state = state; record.reason = reason
      record.updatedAtNs = String(BigInt(record.updatedAtNs) + 1n)
      record.transitions.push({ state, atNs: record.updatedAtNs })
      return structuredClone(record)
    },
  }
  const adapters = Object.fromEntries(ids.map(id => [id, {
    current: () => current.get(id) ?? { version: 'a'.repeat(40), sourceCommit: 'a'.repeat(40), origin: 'builtin', digest: null },
    available: () => true, prepare: async () => {}, canRollback: () => true,
    apply: async step => { applied.push(id); if (failApply) throw Object.assign(new Error('READY_PROBE_FAILED'), { code: 'READY_PROBE_FAILED' }); current.set(id, { ...step.target, origin: 'release' }) },
  }]))
  const catalog = { select: async id => ({ catalogSha256: 'c'.repeat(64), expiresAt: '2099-01-01T00:00:00Z',
    release: { componentId: id, versionId: 'b'.repeat(64), sourceCommit: 'b'.repeat(40), compatibility: {
      nodeMajor: 26, containerUpdate: null, parentProtocol: id === 'notifications' ? 2 : 1, stateSchema: id === 'notifications' ? 2 : 1,
    } } }) }
  let containerStarts = 0
  const containerPlan = { planId: randomUUID(), scope: 'component', componentId: 'container', expiresAt: '2099-01-01T00:00:00Z',
    targets: [{ componentId: 'container', current: null, published: { version: 'sha256:' + 'b'.repeat(64), digest: 'sha256:' + 'b'.repeat(64), sourceCommit: 'b'.repeat(40), origin: 'published' } }],
    compatibility: { compatible: true, reason: null }, impact: { containerRestart: true, description: 'Restart' }, capability: { supported: true, reason: null } }
  const containerHost = { plan: async () => containerPlan, job: host.job, updateJob: host.updateJob,
    admitJob: ({ jobId, idempotencyKey }) => host.admitJob({ jobId, idempotencyKey, kind: 'container',
      target: { catalogSha256: 'c'.repeat(64), moduleId: 'container', versionId: containerPlan.targets[0].published.version } }),
    start: async () => { containerStarts++; throw Error('container must not start') } }
  const executor = await createModuleUpdateExecutor({ root, adapters, catalog, moduleHost: host, ...(container ? { host: containerHost } : {}) })
  t.after(() => executor.close())
  const plan = await executor.plan({ scope: 'all' }, container ? { components: [{ id: 'container',
    publication: { catalog: { sha256: 'c'.repeat(64) } }, comparison: { state: 'update_available' }, capability: { supported: true } }] } : null)
  const input = { planId: plan.planId, requestId: randomUUID(), confirmContainerRestart: container, idempotencyKey: 'one-operation' }
  return { root, executor, jobs, calls, changes, applied, input, containerStarts: () => containerStarts, failReady: (times = Infinity) => { failReady = times }, allowReady: () => { failReady = 0 }, gate: value => { admitGate = value }, fail: value => { failSecond = value } }
}

test('all durable step receipts precede acceptance; same key/new request UUID reuses jobs and actual ready transitions', async t => {
  const f = await fixture(t)
  let release
  f.gate(new Promise(resolve => { release = resolve }))
  let accepted = false
  const started = f.executor.start(f.input).then(value => { accepted = true; return value })
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve))
  assert.equal(accepted, false); assert.equal(f.jobs.size, 0)
  release()
  const first = await started
  assert.equal(first.jobs.length, 2); assert.equal(f.jobs.size, 2)
  const saved = JSON.parse(await readFile(join(f.root, 'state/update-ledger/ledger.json')))
  assert.equal(saved.operations[0].admissionComplete, true)
  assert.ok(saved.operations[0].jobBindings.every(binding => binding.admitted))
  const again = await f.executor.start({ ...f.input, requestId: randomUUID() })
  assert.equal(again.requestId, f.input.requestId); assert.equal(f.calls.length, 2)
  await f.executor.close()
  const complete = await f.executor.operation(f.input.requestId)
  assert.deepEqual(complete.jobs.map(job => job.state), ['ready', 'ready'])
  assert.deepEqual(f.changes.map(([, state]) => state), ['downloading', 'verifying', 'swapping', 'ready', 'downloading', 'verifying', 'swapping', 'ready'])
})

test('partial admission returns an error and retry reuses persisted UUIDs/keys without a second first job', async t => {
  const f = await fixture(t); f.fail(true)
  await assert.rejects(f.executor.start(f.input), { code: 'UNREADABLE' })
  const saved = JSON.parse(await readFile(join(f.root, 'state/update-ledger/ledger.json')))
  assert.equal(saved.operations[0].admissionComplete, false)
  assert.deepEqual(saved.operations[0].jobBindings.map(value => value.admitted), [true, false])
  assert.equal(f.jobs.size, 1); assert.equal(f.changes.length, 0)
  f.fail(false)
  const accepted = await f.executor.start(f.input)
  assert.deepEqual(accepted.jobs.map(job => job.jobId), saved.operations[0].jobBindings.map(value => value.jobId))
  assert.equal(f.calls.length, 3); assert.equal(f.jobs.size, 2)
  await f.executor.close()
})


test('a saved ready report resumes after a reader failure without replaying the completed module exchange', async t => {
  const f = await fixture(t, { ids: ['web-gateway'] }); f.failReady()
  await f.executor.start(f.input)
  await f.executor.close()
  assert.deepEqual(f.applied, ['web-gateway'])
  const saved = JSON.parse(await readFile(join(f.root, 'state/update-ledger/ledger.json')))
  assert.equal(saved.operations[0].steps[0].jobReport.state, 'ready')
  f.allowReady()
  const result = await f.executor.operation(f.input.requestId)
  assert.equal(result.jobs[0].state, 'ready'); assert.equal(result.phase, 'completed')
  assert.deepEqual(f.applied, ['web-gateway'])
})


test('a one-time ready receipt error completes after the saved report is acknowledged', async t => {
  const f = await fixture(t, { ids: ['web-gateway'] }); f.failReady(1)
  await f.executor.start(f.input); await f.executor.close()
  const result = await f.executor.operation(f.input.requestId)
  assert.equal(result.phase, 'completed'); assert.equal(result.jobs[0].state, 'ready')
  assert.deepEqual(f.applied, ['web-gateway'])
})


test('an earlier failed module closes its preadmitted unclaimed container job without starting the container', async t => {
  const f = await fixture(t, { ids: ['web-gateway'], container: true, failApply: true })
  const accepted = await f.executor.start(f.input)
  assert.deepEqual(accepted.jobs.map(job => job.kind), ['module', 'container'])
  await f.executor.close()
  const result = await f.executor.operation(f.input.requestId)
  assert.deepEqual(result.jobs.map(job => job.state), ['failed', 'failed'])
  assert.equal(result.jobs[1].reason.code, 'READY_PROBE_FAILED')
  assert.equal(f.containerStarts(), 0)
})
