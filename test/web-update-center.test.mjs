import assert from 'node:assert/strict'
import test from 'node:test'
import { createUpdateCenter, validUpdateInventory } from '../web/update-center.js'
import { updateExamples, updateComponents, validateUpdates } from '../src/update-center-contract.mjs'
import { webDOM } from './helpers/web-dom.mjs'
import { deferred } from './helpers/editor-dom.mjs'

const settle = () => new Promise(resolve => setImmediate(resolve))
const text = node => [node.textContent ?? '', ...node.children.map(text)].join(' ')
const inventory = () => structuredClone(updateExamples.published_unavailable)
function fixture(t, api, storage) {
  const dom = webDOM(t), root = dom.get('update-center'), calls = []
  const opener = dom.get('update-open')
  const center = createUpdateCenter({ root, buttons: [opener], storage, api: async (...args) => { calls.push(args); return api(...args) } })
  return { root, calls, center, opener, open: () => opener.handlers.click(), get: selector => root.querySelector(selector), select(id) {
    root.querySelector('[data-update-components]').children.find(node => node.dataset.component === id).handlers.click()
  } }
}
test('the display accepts all nine canonical examples and rejects unsafe completion or malformed fields', () => {
  for (const [name, value] of Object.entries(updateExamples)) assert.equal(validUpdateInventory(value), true, name)
  for (const value of [null, {}, { ...inventory(), observedAt: 'invalid' }, { ...inventory(), plans: null },
    { ...inventory(), components: [inventory().components[0], inventory().components[0]] }]) assert.equal(validUpdateInventory(value), false)
  const invalid = structuredClone(updateExamples.verified_completed)
  invalid.operation.verification = 'pending'
  assert.equal(validUpdateInventory(invalid), false)
})

test('inventory is the only data source; all actual components and independent/provider limitations stay distinct', async t => {
  const value = inventory()
  const base = value.components[0]
  value.components = updateComponents.map(([id, name, description]) => ({ ...structuredClone(base), id, name, description,
    current: id === 'notifications' ? { version: 'b'.repeat(40), sourceCommit: 'b'.repeat(40), digest: null, origin: 'builtin' } : null,
    capability: { supported: false, reason: id === 'members' ? 'MODULE_NOT_INDEPENDENT' : 'UPDATE_EXECUTOR_UNAVAILABLE' },
    availability: { available: id === 'notifications' ? false : null, reason: id === 'notifications' ? 'PUSH_NOT_CONFIGURED' : 'AVAILABILITY_UNKNOWN' } }))
  assert.equal(validateUpdates(value).valid, true)
  const f = fixture(t, async () => value)
  assert.equal(f.calls.length, 0)
  await f.center.start()
  assert.deepEqual(f.calls, [['/api/updates']])
  assert.equal(f.get('[data-update-components]').children.length, 10)
  f.select('members')
  assert.match(text(f.get('[data-update-detail]')), /個別更新に対応していません/)
  f.select('notifications')
  assert.match(text(f.get('[data-update-detail]')), /内蔵版 · bbbbbbbbbbbb/)
  assert.match(text(f.get('[data-update-detail]')), /通知が未設定のため、端末へのお知らせを送れません/)
  assert.match(text(f.get('[data-update-detail]')), /実行機構は未接続/)
  const action = f.get('[data-update-detail]').children.find(node => node.className === 'update-execute')
  assert.equal(action.disabled, true)
  assert.ok(f.calls.every(([path, options]) => path === '/api/updates' && !options?.method))
})

test('public operation states keep acceptance, execution and verification separate without invented progress', async t => {
  let value = inventory()
  const f = fixture(t, async () => value)
  for (const name of ['accepted', 'disconnected_unknown', 'execution_failed', 'verified_completed']) {
    value = structuredClone(updateExamples[name]); await f.center.start()
    const body = text(f.get('[data-update-detail]'))
    if (name === 'verified_completed') assert.match(body, /更新完了/)
    else assert.doesNotMatch(body, /更新完了/)
    if (name === 'accepted') { assert.match(body, /受付済み.*実行: 未確認.*稼働確認: 未確認/); assert.match(f.opener.textContent, /更新中/) }
    if (name === 'disconnected_unknown') { assert.match(body, /結果確認不能/); assert.match(f.opener.textContent, /要確認/) }
    if (name === 'execution_failed') assert.match(body, /実行: 失敗/)
  }
  assert.ok(f.calls.every(([, options]) => !options?.method))
})

test('latest failure clears stale versions, older responses and disposed reads do not overwrite, and auth/404 differ', async t => {
  const first = deferred(); let reads = 0, status = null
  const f = fixture(t, async () => {
    if (status) throw Object.assign(Error(), { status })
    if (++reads === 1) return first.promise
    return inventory()
  })
  f.open(); await f.center.refresh()
  first.resolve({}); await settle()
  assert.equal(f.get('[data-update-components]').children.length, 2)
  status = 403; await f.center.refresh()
  assert.match(f.get('[data-update-notice]').textContent, /権限がありません/)
  assert.equal(f.get('[data-update-components]').children.length, 1)
  status = 404; await f.center.refresh()
  assert.match(f.get('[data-update-notice]').textContent, /レビュー用/)
  const before = f.calls.length
  f.center.close(); await f.center.refresh()
  assert.equal(f.calls.length, before)
})

const requestKey = 'bellteam-update-request.v1'
const find = (node, predicate) => predicate(node) ? node : node.children.map(child => find(child, predicate)).find(Boolean)
const control = (f, name) => find(f.get('[data-update-detail]'), node => node.dataset?.updateControl === name)
const storeFixture = () => { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) } }
function executable() {
  const value = structuredClone(updateExamples.restart_required)
  const fixedPlan = value.plans[0]
  fixedPlan.expiresAt = new Date(Date.now() + 300000).toISOString()
  value.plans = []
  return { value, fixedPlan }
}
const receipt = (fixedPlan, requestId, phase = 'applying') => ({ requestId, plan: fixedPlan, admission: 'accepted', phase,
  execution: phase === 'completed' ? 'succeeded' : 'pending', verification: phase === 'completed' ? 'succeeded' : 'pending', error: null, reference: requestId })
async function obtainPlan(f) { await f.center.start(); f.select('container'); control(f, 'execute').handlers.click(); await settle() }
function confirm(f) { const input = control(f, 'restart-confirm'); input.checked = true; input.handlers.change() }

test('container plan needs explicit restart confirmation, freezes target and submits one canonical request', async t => {
  const { value, fixedPlan } = executable(), storage = storeFixture(), response = deferred()
  let accepted = null, body = null
  const f = fixture(t, async (path, options) => {
    if (path === '/api/updates') return value
    if (path.endsWith('/plans')) { assert.deepEqual(JSON.parse(options.body), { scope: 'component', componentId: 'container' }); return { plan: fixedPlan } }
    if (path.endsWith('/operations')) { body = JSON.parse(options.body); return response.promise }
    return { operation: accepted }
  }, storage)
  await obtainPlan(f)
  assert.equal(control(f, 'execute').disabled, true)
  control(f, 'execute').handlers.click(); await settle()
  assert.equal(body, null)
  confirm(f)
  assert.equal(control(f, 'execute').disabled, false)
  const button = control(f, 'execute')
  button.handlers.click(); button.handlers.click(); await settle()
  assert.equal(f.calls.filter(([path]) => path === '/api/updates/operations').length, 1)
  assert.match(body.requestId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
  assert.equal(body.planId, fixedPlan.planId); assert.equal(body.confirmContainerRestart, true)
  assert.equal(JSON.parse(storage.getItem(requestKey)).requestId, body.requestId)
  accepted = receipt(fixedPlan, body.requestId); response.resolve({ operation: accepted }); await settle()
  assert.match(text(f.get('[data-update-detail]')), /受付済み/)
  assert.doesNotMatch(text(f.get('[data-update-detail]')), /更新完了/)
  assert.ok(f.calls.some(([path]) => path === '/api/updates/operations/' + body.requestId))
})

test('lost POST response survives reload and catalog outage; recovery only reads the identical request', async t => {
  const { value, fixedPlan } = executable(), storage = storeFixture()
  let sent, completed = false
  const api = async (path, options) => {
    if (path === '/api/updates') { if (completed) throw Object.assign(Error(), { status: 503 }); return value }
    if (path.endsWith('/plans')) return { plan: fixedPlan }
    if (path === '/api/updates/operations') { sent = JSON.parse(options.body); throw new TypeError('connection lost') }
    if (!completed) throw Object.assign(Error(), { status: 404 })
    assert.equal(path, '/api/updates/operations/' + sent.requestId)
    return { operation: receipt(fixedPlan, sent.requestId, 'completed') }
  }
  const first = fixture(t, api, storage)
  await obtainPlan(first); confirm(first); control(first, 'execute').handlers.click(); await settle()
  assert.ok(storage.getItem(requestKey))
  await first.center.refresh(); await first.center.refresh()
  assert.equal(first.calls.filter(([path]) => path === '/api/updates/operations').length, 1)
  first.center.close(); completed = true
  const reloaded = fixture(t, api, storage)
  await reloaded.center.start()
  assert.match(text(reloaded.get('[data-update-detail]')), /更新完了/)
  assert.equal(storage.getItem(requestKey), null)
  assert.ok(reloaded.calls.every(([, options]) => !options?.method))
  assert.ok(reloaded.calls.some(([path]) => path.endsWith(sent.requestId)))
})

test('409 rejects the old plan without a retry, and expired plans cannot start', async t => {
  const { value, fixedPlan } = executable(), storage = storeFixture()
  const f = fixture(t, async path => {
    if (path === '/api/updates') return value
    if (path.endsWith('/plans')) return { plan: fixedPlan }
    throw Object.assign(Error(), { status: 409 })
  }, storage)
  await obtainPlan(f); confirm(f); control(f, 'execute').handlers.click(); await settle()
  assert.equal(storage.getItem(requestKey), null)
  assert.match(text(f.get('[data-update-detail]')), /受け付けられませんでした/)
  assert.equal(f.calls.filter(([path]) => path === '/api/updates/operations').length, 1)
  control(f, 'execute').handlers.click(); await settle(); confirm(f)
  t.mock.method(Date, 'now', () => Date.parse(fixedPlan.expiresAt) + 1)
  control(f, 'execute').handlers.click(); await settle()
  assert.match(text(f.get('[data-update-detail]')), /有効期限が切れました/)
  assert.equal(f.calls.filter(([path]) => path === '/api/updates/operations').length, 1)
})

test('storage failure, wrong request result and invalid saved IDs never permit a new or repeated mutation', async t => {
  const { value, fixedPlan } = executable()
  const blocked = fixture(t, async path => path.endsWith('/plans') ? { plan: fixedPlan } : value,
    { getItem: () => null, setItem() { throw Error('blocked') }, removeItem() {} })
  await obtainPlan(blocked); confirm(blocked); control(blocked, 'execute').handlers.click(); await settle()
  assert.match(text(blocked.get('[data-update-detail]')), /更新は開始していません/)
  assert.equal(blocked.calls.filter(([path]) => path === '/api/updates/operations').length, 0)
  const storage = storeFixture()
  storage.setItem(requestKey, JSON.stringify({ planId: fixedPlan.planId, requestId: '22222222-2222-4222-8222-222222222222' }))
  const wrong = fixture(t, async path => path === '/api/updates' ? value : { operation: receipt(fixedPlan, '33333333-3333-4333-8333-333333333333', 'completed') }, storage)
  await wrong.center.start()
  assert.doesNotMatch(text(wrong.get('[data-update-detail]')), /更新完了/)
  assert.ok(storage.getItem(requestKey))
  assert.ok(wrong.calls.every(([, options]) => !options?.method))
  storage.setItem(requestKey, 'invalid')
  const invalid = fixture(t, async () => value, storage)
  await invalid.center.start(); invalid.select('container')
  assert.equal(control(invalid, 'execute').disabled, true)
})

test('publication failure or unknown never claims latest; accepted catalog and execution capability stay separate', async t => {
  let value = structuredClone(updateExamples.no_update)
  const f = fixture(t, async () => value)
  for (const status of ['failed', 'unconfirmed', 'verified']) {
    value.components[0].publication = { catalog: { sha256: 'c'.repeat(64), publishedAt: '2026-11-03T00:00:00Z', expiresAt: '2026-11-04T00:00:00Z' }, check: { status, checkedAt: null, error: status === 'failed' ? 'FEED_FAILED' : null } }
    assert.equal(validateUpdates(value).valid, true)
    await f.center.start(); f.select('container')
    const body = text(f.get('[data-update-detail]'))
    if (status === 'verified') assert.match(body, /正式公開版と一致/)
    else { assert.doesNotMatch(body, /正式公開版と一致/); assert.match(body, /最新版とは確認できていません/); }
  }
  value = { ...value, components: [{ ...value.components[0], publication: undefined }] }
  assert.equal(validUpdateInventory(value), false)
})

test('a plan arriving after selection changes is ignored and all requires its own explicit plan', async t => {
  const { value, fixedPlan } = executable(), pendingPlan = deferred()
  const f = fixture(t, async path => path.endsWith('/plans') ? pendingPlan.promise : value, storeFixture())
  await f.center.start(); f.select('container'); control(f, 'execute').handlers.click()
  f.select('all'); pendingPlan.resolve({ plan: fixedPlan }); await settle()
  assert.equal(control(f, 'execute').disabled, false)
  assert.equal(control(f, 'restart-confirm'), undefined)
  assert.equal(f.calls.filter(([path]) => path === '/api/updates/operations').length, 0)
})

test('HTTP browsers without randomUUID still use platform randomness for canonical lowercase UUIDv4', async t => {
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues } })
  t.after(() => Object.defineProperty(globalThis, 'crypto', cryptoDescriptor))
  const { value, fixedPlan } = executable()
  let body
  const f = fixture(t, async (path, options) => {
    if (path === '/api/updates') return value
    if (path.endsWith('/plans')) return { plan: fixedPlan }
    if (path === '/api/updates/operations') body = JSON.parse(options.body)
    return { operation: receipt(fixedPlan, body.requestId) }
  }, storeFixture())
  await obtainPlan(f); confirm(f); control(f, 'execute').handlers.click(); await settle()
  assert.match(body.requestId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
  assert.equal(f.calls.filter(([path]) => path === '/api/updates/operations').length, 1)
})

test('body explains effects once while codes and complete fixed values stay in expandable support details', async t => {
  const { value, fixedPlan } = executable()
  const code = 'HOST_UPDATE_PUBLICATION_FAILED'
  value.components[0].availability = { available: null, reason: 'AVAILABILITY_UNKNOWN' }
  value.components[0].comparison = { state: 'unknown', reason: code }
  value.components[0].publication = { catalog: { sha256: 'c'.repeat(64), publishedAt: '2026-11-03T00:00:00Z', expiresAt: '2026-11-04T00:00:00Z' }, check: { status: 'failed', checkedAt: null, error: code } }
  fixedPlan.targets[0].published.version = fixedPlan.targets[0].published.digest
  const f = fixture(t, async path => path.endsWith('/plans') ? { plan: fixedPlan } : value, storeFixture())
  await obtainPlan(f)
  const detail = f.get('[data-update-detail]')
  const support = detail.children.find(node => node.className === 'update-support')
  const body = detail.children.filter(node => node !== support).map(text).join(' ')
  assert.doesNotMatch(body, /HOST_UPDATE_PUBLICATION_FAILED/)
  assert.doesNotMatch(body, /利用状態を確認できません/)
  assert.match(body, /稼働状況を取得できていません。更新可否は計画で確認/)
  assert.match(body, /失敗しました。最新版とは確認できていません/)
  assert.doesNotMatch(body, new RegExp(fixedPlan.targets[0].published.version))
  assert.match(body, /固定した更新先: bbbbbbbbbbbb/)
  assert.equal(support.open, false)
  assert.match(text(support), /HOST_UPDATE_PUBLICATION_FAILED/)
  assert.match(text(support), new RegExp(fixedPlan.targets[0].published.version))
  assert.match(text(support), new RegExp(fixedPlan.planId))
  support.open = true; await f.center.refresh()
  assert.equal(f.get('[data-update-detail]').children.find(node => node.className === 'update-support').open, true)
})
