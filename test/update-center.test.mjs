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

async function serverFixture(t, { internal = false, authenticated = true } = {}) {
  const center = createUpdateCenter()
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
