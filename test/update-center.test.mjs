import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { createUpdateCenter } from '../src/update-center.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'
import { updateExamples, validateUpdates, validateUpdateRequest } from '../src/update-center-contract.mjs'

test('有限9状態/nullの正本を検証し、余分fieldと未検証completedを拒否する', () => {
  assert.equal(Object.keys(updateExamples).length, 9)
  for (const [name, value] of Object.entries(updateExamples)) assert.equal(validateUpdates(value).valid, true, name)
  assert.throws(() => validateUpdateRequest('requestId', '11111111-1111-1111-8111-111111111111'), { code: 'UPDATE_INPUT_INVALID' })
  const invalid = structuredClone(updateExamples.verified_completed)
  invalid.operation.verification = 'pending'
  assert.equal(validateUpdates(invalid).valid, false)
  const extra = structuredClone(updateExamples.published_unavailable)
  extra.components[0].fakeProgress = 100
  assert.equal(validateUpdates(extra).valid, false)
  for (const value of [{ scope: 'all', componentId: 'notifications' }, { scope: 'component', componentId: 'foreign' }, { scope: 'all', path: '/unsafe' }])
    assert.throws(() => validateUpdateRequest('plan', value), { code: 'UPDATE_INPUT_INVALID' })
})

test('実current/builtinと通知利用可否を分け、catalogも耐久受付も捏造しない', () => {
  let calls = 0
  const web = { versionId: 'a'.repeat(64), pid: 1 }
  const push = { currentVersionId: null, builtinSourceCommit: 'b'.repeat(40), available: true, status: { configured: false }, applyError: null }
  const center = createUpdateCenter({ gateway: () => web, notifications: { controller: {
    snapshot() { calls++; return push }, reserve() { throw Error('no mutation') },
  } } })
  const before = center.snapshot()
  assert.equal(before.components.find(item => item.id === 'web-gateway').current.version, web.versionId)
  const notification = before.components.find(item => item.id === 'notifications')
  assert.equal(notification.current.origin, 'builtin')
  assert.equal(notification.current.sourceCommit, push.builtinSourceCommit)
  assert.equal(notification.availability.available, false)
  assert.equal(notification.published, null)
  assert.equal(notification.capability.supported, false)
  assert.deepEqual(before.plans, []); assert.equal(before.operation, null)
  assert.equal(calls, 1)
  assert.throws(() => center.plan({ scope: 'all' }), { status: 503 })
  assert.throws(() => center.start({ planId: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222', confirmContainerRestart: true }), { status: 503 })
  assert.equal(calls, 1)
})

async function serverFixture(t, { internal = false, authenticated = true, center = createUpdateCenter() } = {}) {
  let refreshes = 0
  const bots = Object.assign(new Map(), { async refresh() { refreshes++ } })
  const server = createBellTeamServer({ bots, store: { async watch() { return () => {} } }, transport: {}, updateCenter: center,
    internal, authorize: async () => authenticated, writeLog() {},
  })
  await server.startMessageWatch()
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  return { center, refreshCount: () => refreshes, request: (path, options) => fetch(`http://127.0.0.1:${server.address().port}` + path, options) }
}

test('Owner HTTPは厳密入力と未供給503、内部/認証拒否403を保つ', async t => {
  const { request, refreshCount } = await serverFixture(t)
  const inventory = await request('/api/updates')
  assert.equal(inventory.status, 200); assert.equal(validateUpdates(await inventory.json()).valid, true)
  for (const [path, body, status] of [
    ['/api/updates/plans', { scope: 'all' }, 503],
    ['/api/updates/plans', { scope: 'all', path: '/arbitrary' }, 400],
    ['/api/updates/operations', { planId: 'invalid', requestId: 'invalid', confirmContainerRestart: false }, 400],
  ]) assert.equal((await request(path, { method: 'POST', body: JSON.stringify(body) })).status, status)
  assert.equal((await request('/api/updates/operations/not-a-uuid')).status, 400)
  assert.equal((await request('/api/updates/operations/22222222-2222-4222-8222-222222222222')).status, 503)
  assert.equal((await request('/api/updates', { method: 'POST' })).status, 405)
  assert.equal((await request('/api/updates/foreign')).status, 404)
  assert.equal(refreshCount(), 0)
  const internal = await serverFixture(t, { internal: true })
  assert.equal((await internal.request('/api/updates')).status, 403)
  const denied = await serverFixture(t, { authenticated: false })
  assert.equal((await denied.request('/api/updates')).status, 403)
})

test('POST catalog-checkは公式取得を一回要求し、記録を200で返し、他methodと内部/認証拒否を保つ', async t => {
  const record = { status: 'failed', checkedAt: '2026-11-08T00:00:00Z', error: 'HOST_UPDATE_PUBLICATION_UNCONFIRMED' }
  let checks = 0
  const center = createUpdateCenter({ moduleCatalog: { checkCatalog: async () => { checks++; return record } } })
  const { request } = await serverFixture(t, { center })
  const response = await request('/api/updates/catalog-check', { method: 'POST' })
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { publication: record }); assert.equal(checks, 1)
  assert.equal((await request('/api/updates/catalog-check')).status, 405)
  assert.equal((await (await serverFixture(t)).request('/api/updates/catalog-check', { method: 'POST' })).status, 503)
  assert.equal((await (await serverFixture(t, { center, internal: true })).request('/api/updates/catalog-check', { method: 'POST' })).status, 403)
  assert.equal((await (await serverFixture(t, { center, authenticated: false })).request('/api/updates/catalog-check', { method: 'POST' })).status, 403)
  assert.equal(checks, 1)
})

test('Update変更は既SSEのmessages/type=updatesだけを使い、watch停止後は届かない', async t => {
  const { request, center } = await serverFixture(t)
  const stream = await request('/api/events'), reader = stream.body.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/)
  center.notify()
  const event = new TextDecoder().decode((await reader.read()).value)
  assert.match(event, /event: messages/)
  const value = JSON.parse(event.match(/data: (.+)/)[1])
  assert.equal(value.type, 'updates'); assert.deepEqual(value.topics, ['updates'])
  assert.deepEqual(value.botIds, []); assert.deepEqual(value.roomIds, [])
  await reader.cancel()
  let called = 0
  const stop = center.watch(() => { called++ })
  center.notify(); stop(); center.notify()
  assert.equal(called, 1)
})


test('members inventory uses the same controller and keeps durable executor unavailable', () => {
  const source = '1'.repeat(40), digest = '2'.repeat(64)
  let state = { builtinSourceCommit: source, currentVersionId: null, available: true }
  const center = createUpdateCenter({ members: { controller: { snapshot: () => state } } })
  let member = center.snapshot().components.find(item => item.id === 'members')
  assert.equal(member.current.sourceCommit, source)
  assert.equal(member.current.origin, 'builtin')
  assert.equal(member.availability.available, true)
  assert.deepEqual(member.capability, { supported: false, reason: 'UPDATE_EXECUTOR_UNAVAILABLE' })
  state = { ...state, currentVersionId: digest, available: false }
  member = center.snapshot().components.find(item => item.id === 'members')
  assert.equal(member.current.digest, `sha256:${digest}`)
  assert.deepEqual(member.availability, { available: false, reason: 'MEMBERS_UNAVAILABLE' })
  assert.equal(member.published, null)
})

test('each part gets one plain status line from only its latest job', async () => {
  const { componentStatus } = await import('../src/update-center.mjs')
  const { validateUpdates } = await import('../src/update-center-contract.mjs')
  const at = '1794100000000000000' // 2026-11-08T01:06:40Z = 11/8 10:06 JST
  const record = (jobId, moduleId, state, updatedAtNs, code) => ({ schema: 'bellteam.update-job.v1', jobId, idempotencyKey: jobId,
    kind: moduleId === 'container' ? 'container' : 'module', target: { catalogSha256: null, moduleId, versionId: 'builtin' }, state,
    reason: code ? { code, message: code } : null, transitions: [{ state, atNs: updatedAtNs }], updatedAtNs })
  const jobs = [record('11111111-1111-4111-8111-111111111111', 'execution', 'failed', '1794000000000000000', 'EXECUTION_BUSY'),
    record('22222222-2222-4222-8222-222222222222', 'execution', 'ready', at),
    record('33333333-3333-4333-8333-333333333333', 'conversation', 'failed', at, 'DIAGNOSTIC_INVALID'),
    record('44444444-4444-4444-8444-444444444444', 'container', 'failed', at, 'HOST_UPDATE_INSTALL_FAILED')]
  const row = (id, available, origin = 'builtin') => ({ id, current: { version: 'v', sourceCommit: null, digest: null, origin },
    comparison: { state: 'unavailable', reason: 'PUBLISHED_RELEASE_UNAVAILABLE' }, availability: { available, reason: null } })
  const superseded = componentStatus(row('execution', true, 'release'), jobs)
  assert.equal(superseded.latestJob.jobId, '22222222-2222-4222-8222-222222222222')
  assert.equal(superseded.line, '更新で入れた版を使っています。新しい版があるかは確認できません。11/8 10:06 の更新は完了しました。')
  const named = { ...row('execution', true, 'release'), current: { version: 'a'.repeat(64), sourceCommit: 'bd4fe72c'.padEnd(40, '0'), digest: null, origin: 'release' },
    published: { version: 'c'.repeat(64), sourceCommit: '9b964b12'.padEnd(40, '0'), digest: null, origin: 'published' }, comparison: { state: 'update_available', reason: null } }
  assert.equal(componentStatus(named, []).line, '更新で入れた版（bd4fe72）を使っています。新しい版（9b964b1）があります。')
  const fixedSince = componentStatus({ ...row('conversation', true), comparison: { state: 'up_to_date', reason: null } }, jobs)
  assert.equal(fixedSince.line, '最初から入っている版を使っています。最新です。'); assert.equal(fixedSince.latestJob.state, 'failed')
  assert.equal(superseded.tone, 'ok'); assert.equal(superseded.actionRequired, false)
  const body = componentStatus(row('container', null), jobs)
  assert.match(body.line, /^本体は動いています。.*11\/8 10:06 の更新は入れ替えの途中で失敗しました。元の版のまま動いています。対応は不要です。$/u)
  assert.equal(body.actionRequired, false); assert.doesNotMatch(body.line, /HOST_|4444/u)
  const stopped = componentStatus(row('conversation', false), jobs)
  assert.equal(stopped.tone, 'attention'); assert.equal(stopped.actionRequired, true); assert.match(stopped.line, /この機能は今使えません。$/u)
  assert.deepEqual(stopped.latestJob.reason, { code: 'DIAGNOSTIC_INVALID', message: 'DIAGNOSTIC_INVALID' })
  assert.equal(componentStatus(row('memory', true), jobs).latestJob, null)
  const center = createUpdateCenter({ jobReader: { jobs: async () => ({ jobs }) } })
  const inventory = await center.snapshot()
  assert.equal(inventory.components.find(item => item.id === 'execution').status.latestJob.state, 'ready')
  assert.equal(validateUpdates(inventory).valid, true)
})

test('one catalog check refreshes the module store and the container Host store', async () => {
  const calls = []
  const reported = []
  const center = createUpdateCenter({ onCatalogCheckError: error => reported.push(error.code), moduleCatalog: { checkCatalog: async () => { calls.push('module'); return { status: 'verified' } }, snapshot: value => value },
    host: { checkCatalog: async () => { calls.push('container'); throw Object.assign(new Error('x'), { code: 'UNREADABLE' }) }, snapshot: value => value } })
  assert.deepEqual(await center.checkCatalog(), { status: 'verified' })
  assert.deepEqual(calls.sort(), ['container', 'module'])
  assert.deepEqual(reported, ['UNREADABLE'])
})
