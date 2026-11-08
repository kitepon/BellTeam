import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createHostUpdateAdapter } from '../src/update-host-adapter.mjs'
import { createUpdateCenter } from '../src/update-center.mjs'
const id = '22222222-2222-4222-8222-222222222222'
const release = { componentId: 'container', sourceCommit: 'b'.repeat(40), versionId: 'sha256:' + 'b'.repeat(64),
  artifact: { kind: 'oci-index', reference: 'ghcr.io/kitepon/bellteam-server@sha256:' + 'b'.repeat(64) },
  compatibility: { containerUpdate: 1 }, changes: ['更新'] }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'update-host-')); t.after(() => rm(root, { recursive: true, force: true }))
  let plan, receipt, starts = 0, catalogMissing = false, unknown = false
  const client = {
    capabilities: async () => ({ supported: !catalogMissing, reason: catalogMissing ? 'HOST_UPDATE_CATALOG_UNAVAILABLE' : null, currentRequestId: receipt?.requestId ?? null, previousRequestId: null }),
    catalog: async () => { if (catalogMissing) throw Object.assign(new Error(), { code: 'HOST_UPDATE_CATALOG_UNAVAILABLE' }); return {
      schema: 'bellteam.update-catalog.selection.v1', catalogSha256: 'c'.repeat(64), publishedAt: '2026-11-03T00:00:00Z', expiresAt: '2026-11-04T00:00:00Z', release,
      publication: { status: 'failed', checkedAt: '2026-11-03T01:00:00Z', error: 'HOST_UPDATE_PUBLICATION_FAILED' } } },
    plan: async input => (plan = { schema: 'bellteam.host-update.plan.v1', ...input, target: release, expiresAt: '2026-11-03T23:00:00Z', impact: { containerRestart: true },
      expected: { sourceCommit: 'a'.repeat(40), imageRef: 'ghcr.io/kitepon/bellteam-server@sha256:' + 'a'.repeat(64) } }),
    start: async input => { starts++; if (unknown) throw Object.assign(new Error(), { code: 'HOST_UPDATE_HANDOFF_UNKNOWN', status: 503 }); return receipt = {
      requestId: input.requestId, planId: input.planId, target: release, admission: 'accepted', phase: 'applying', execution: 'pending', verification: 'pending', error: null } },
    operation: async () => receipt,
  }
  return { root, client, count: () => starts, missing: () => { catalogMissing = true }, unknown: () => { unknown = true }, receipt: () => receipt }
}
test('public plan survives reconstruction and same request result remains readable without catalog', async t => {
  const f = await fixture(t), first = createHostUpdateAdapter(f)
  const plan = await first.plan({ scope: 'component', componentId: 'container' })
  assert.equal(plan.targets[0].current.sourceCommit, 'a'.repeat(40)); assert.equal(plan.expiresAt, '2026-11-03T23:00:00Z')
  await assert.rejects(first.start({ planId: plan.planId, requestId: id, confirmContainerRestart: false }), { status: 409 }); assert.equal(f.count(), 0)
  const next = createHostUpdateAdapter(f)
  const result = await next.start({ planId: plan.planId, requestId: id, confirmContainerRestart: true })
  assert.equal(result.requestId, id); assert.equal(result.plan.expiresAt, plan.expiresAt); assert.equal(f.count(), 1)
  f.receipt().phase = 'completed'
  await assert.rejects(next.operation(id), { code: 'UPDATE_RESPONSE_INVALID' })
  f.receipt().phase = 'applying'
  f.missing()
  const snapshot = await createUpdateCenter({ host: createHostUpdateAdapter(f) }).snapshot()
  assert.equal(snapshot.operation.requestId, id); assert.equal(snapshot.operation.execution, 'pending')
  assert.equal(snapshot.components[0].published, null); assert.equal(f.count(), 1)
})
test('feed failure is separate from accepted catalog; no plan or worker is fabricated on GET', async t => {
  const f = await fixture(t), center = createUpdateCenter({ host: createHostUpdateAdapter(f) })
  const state = await center.snapshot(), item = state.components[0]
  assert.equal(item.published.sourceCommit, release.sourceCommit)
  assert.equal(item.publication.check.status, 'failed'); assert.equal(item.publication.catalog.sha256, 'c'.repeat(64))
  assert.equal(state.operation, null); assert.equal(f.count(), 0)
})
test('the body running the published commit is up to date although its own digest is unknown', async t => {
  const f = await fixture(t)
  const center = sourceCommit => createUpdateCenter({ host: createHostUpdateAdapter(f), notifications: { controller: { snapshot: () => ({ builtinSourceCommit: sourceCommit }) } } })
  const same = (await center(release.sourceCommit).snapshot()).components.find(item => item.id === 'container')
  assert.equal(same.current.digest, null); assert.equal(same.comparison.state, 'up_to_date')
  assert.deepEqual(same.capability, { supported: false, reason: 'UPDATE_ALREADY_CURRENT' })
  assert.match(same.status.line, /^本体は版 bbbbbbb で動いています。最新です。/u)
  const older = (await center('a'.repeat(40)).snapshot()).components.find(item => item.id === 'container')
  assert.equal(older.comparison.state, 'update_available')
})
test('unknown start is not retried and Host result cannot claim unverified completion', async t => {
  const f = await fixture(t), adapter = createHostUpdateAdapter(f)
  const plan = await adapter.plan({ scope: 'component', componentId: 'container' }); f.unknown()
  await assert.rejects(adapter.start({ planId: plan.planId, requestId: id, confirmContainerRestart: true }), { code: 'HOST_UPDATE_HANDOFF_UNKNOWN' })
  assert.equal(f.count(), 1)
  await assert.rejects(adapter.plan({ scope: 'all' }), { status: 503 })
  await assert.rejects(adapter.operation('../unsafe'), { status: 400 })
})
test('real Owner HTTP returns 202 only after Host admission and exposes same request GET', async t => {
  const { createBellTeamServer } = await import('../src/http-server.mjs')
  const { once } = await import('node:events')
  const f = await fixture(t)
  let entered, releaseAck
  const admitted = new Promise(resolve => { entered = resolve }), ack = new Promise(resolve => { releaseAck = resolve })
  const original = f.client.start
  f.client.start = async input => { entered(); await ack; return original(input) }
  const center = createUpdateCenter({ host: createHostUpdateAdapter(f) })
  const server = createBellTeamServer({ bots: new Map(), store: {}, transport: {}, updateCenter: center, authorize: async () => true, writeLog() {} })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/api/updates`
  const planResponse = await fetch(url + '/plans', { method: 'POST', body: JSON.stringify({ scope: 'component', componentId: 'container' }) })
  const { plan } = await planResponse.json(); assert.equal(planResponse.status, 200)
  let returned = false
  const request = fetch(url + '/operations', { method: 'POST', body: JSON.stringify({ requestId: id, planId: plan.planId, confirmContainerRestart: true }) }).then(value => { returned = true; return value })
  await admitted; assert.equal(returned, false); assert.equal(f.count(), 0)
  releaseAck()
  const response = await request; assert.equal(response.status, 202)
  assert.equal((await response.json()).operation.requestId, id)
  const read = await fetch(url + '/operations/' + id); assert.equal(read.status, 200)
  assert.equal((await read.json()).operation.requestId, id); assert.equal(f.count(), 1)
})
