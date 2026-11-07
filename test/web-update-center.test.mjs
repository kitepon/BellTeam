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
test('restart-limit problems display supplied evidence and explicit resolution without writes', async t => {
  const value = inventory()
  const problem = { fingerprint: 'a'.repeat(64), status: 'open', kind: 'module_restart_limit',
    moduleId: value.components[0].id, count: 7, windowSeconds: 1800,
    lastExit: { code: null, signal: null }, lastReason: 'ready_probe_failed' }
  value.problems = [problem]
  const f = fixture(t, async () => value)
  const rows = () => f.get('[data-update-product]').children.find(node => node.className === 'update-release-notes update-problems')
  await f.center.start()
  assert.equal(validUpdateInventory(value), true)
  assert.equal(rows().children[1].dataset.problemFingerprint, problem.fingerprint)
  assert.match(text(rows()), new RegExp(value.components[0].name))
  assert.match(text(rows()), /問題あり.*再起動回数: 7.*1800.*終了コード: 未観測.*シグナル: 未観測.*ready_probe_failed/)
  await f.center.refresh()
  assert.match(text(rows()), /問題あり.*再起動回数: 7/)
  problem.status = 'resolved'
  await f.center.refresh()
  assert.equal(rows().children[1].dataset.problemFingerprint, problem.fingerprint)
  assert.match(text(rows()), /解決済み.*再起動回数: 7.*ready_probe_failed/)
  problem.status = 'open'; problem.count = 5; problem.lastExit = { code: 0, signal: 'SIGTERM' }; problem.lastReason = 'process_exit'
  await f.center.refresh()
  assert.match(text(rows()), /問題あり.*再起動回数: 5.*終了コード: 0.*シグナル: SIGTERM.*process_exit/)
  for (const invalid of [null, {}, { ...problem, lastExit: null }, { ...problem, lastReason: {} }]) {
    assert.equal(validUpdateInventory({ ...value, problems: [invalid] }), false)
  }
  delete value.problems
  await f.center.refresh()
  assert.equal(validUpdateInventory(value), true)
  assert.equal(rows(), undefined)
  assert.ok(f.calls.every(([path, options]) => path === '/api/updates' && !options?.method))
})
test('the display accepts historical examples and validates consumed fields', () => {
  for (const [name, value] of Object.entries(updateExamples)) assert.equal(validUpdateInventory(value), true, name)
  for (const value of [null, {}, { ...inventory(), observedAt: 'invalid' }, { ...inventory(), plans: null },
    { ...inventory(), components: [inventory().components[0], inventory().components[0]] }]) assert.equal(validUpdateInventory(value), false)
  const invalid = structuredClone(updateExamples.verified_completed)
  invalid.operation.verification = 'pending'
  assert.equal(validUpdateInventory(invalid), true)
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

const storedJob = (jobId, state = 'queued', moduleId = 'container') => ({
  schema: 'bellteam.update-job.v1', jobId, idempotencyKey: jobId,
  kind: moduleId === 'container' ? 'container' : 'module',
  target: { catalogSha256: 'c'.repeat(64), moduleId, versionId: 'b'.repeat(64) }, state,
  reason: state === 'failed' ? { code: 'READY_PROBE_FAILED', message: '実際の応答を確認できませんでした。<img src=x>' } : null,
  transitions: [{ state, atNs: '1793999999999999999' }], updatedAtNs: '1793999999999999999',
})

test('stored update jobs display all six exact records without a parent aggregate or fabricated legacy state', async t => {
  const value = structuredClone(updateExamples.verified_completed)
  value.operation.verification = 'pending'
  const states = ['queued', 'downloading', 'verifying', 'swapping', 'ready', 'failed']
  const records = states.map((state, index) => storedJob(`0000000${index}-0000-4000-8000-000000000000`, state, index ? 'notifications' : 'container'))
  value.jobs = records; value.operation.jobs = records.slice(0, 2)
  let offline = false
  const f = fixture(t, async () => { if (offline) throw Error('NETWORK_READ_FAILED'); return value })
  await f.center.start()
  assert.equal(validUpdateInventory(value), true)
  const product = f.get('[data-update-product]'), body = text(product)
  for (const record of records) {
    assert.match(body, new RegExp(`状態: ${record.state}`))
    assert.match(body, new RegExp(record.jobId))
  }
  const rows = product.children.find(node => node.className === 'update-release-notes update-jobs').children.slice(1)
  assert.equal(rows.length, 6)
  assert.match(body, /READY_PROBE_FAILED \/ 実際の応答を確認できませんでした。<img src=x>/)
  assert.doesNotMatch(body, /更新しました|結果不明|結果確認不能|状態: unknown/)
  assert.notEqual(value.operation.requestId, records[0].jobId)
  for (const bad of [{ ...records[0], state: 'unknown' }, { ...records[0], reason: {} }, { ...records[5], reason: null }]) {
    assert.equal(validUpdateInventory({ ...value, jobs: [bad] }), false)
  }
  delete value.jobs; delete value.operation.jobs
  Object.assign(value.operation, { phase: 'unknown', admission: 'unknown', error: { code: 'HISTORICAL_ERROR', message: '以前の操作記録です。' } })
  await f.center.refresh()
  assert.match(text(f.get('[data-update-detail]')), /保存されたジョブの記録はありません.*HISTORICAL_ERROR \/ 以前の操作記録です。/)
  assert.doesNotMatch(text(f.get('[data-update-detail]')), /結果不明|結果確認不能|状態: unknown|更新完了/)
  assert.ok(f.calls.every(([path, options]) => path === '/api/updates' && !options?.method))
  offline = true
  await f.center.refresh({ type: 'updates', jobs: [records[5]] })
  assert.match(text(f.get('[data-update-product]')), /NETWORK_READ_FAILED.*状態: failed.*READY_PROBE_FAILED/)
  assert.doesNotMatch(text(f.get('[data-update-product]')), /状態: unknown|結果不明/)
  const storage = storeFixture(), historical = structuredClone(value.operation)
  storage.setItem(requestKey, JSON.stringify({ previous: [historical] }))
  const restored = fixture(t, async path => {
    if (path === '/api/updates') return value
    throw Error('HISTORICAL_READ_FAILED')
  }, storage)
  await restored.center.start()
  assert.deepEqual(JSON.parse(storage.getItem(requestKey)).previous, [historical])
  assert.match(text(restored.get('[data-update-detail]')), /HISTORICAL_READ_FAILED/)
})

test('coalesced refresh applies the trailing read, latest failure clears versions, and disposal and auth/404 differ', async t => {
  const first = deferred(); let reads = 0, status = null
  const f = fixture(t, async () => {
    if (status) throw Object.assign(Error(), { status })
    if (++reads === 1) return first.promise
    return inventory()
  })
  const opened = f.center.open(f.opener), refreshed = f.center.refresh()
  first.resolve({}); await opened; await refreshed
  assert.equal(f.get('[data-update-components]').children.length, 2)
  status = 403; await f.center.refresh()
  assert.match(f.get('[data-update-notice]').textContent, /権限がありません/)
  assert.equal(f.get('[data-update-components]').children.length, 1)
  status = 404; await f.center.refresh()
  assert.match(f.get('[data-update-notice]').textContent, /未提供/)
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
  execution: phase === 'completed' ? 'succeeded' : 'pending', verification: phase === 'completed' ? 'succeeded' : 'pending', error: null, reference: requestId,
  jobs: [storedJob(requestId, phase === 'completed' ? 'ready' : 'queued')] })
async function obtainPlan(f) { await f.center.start(); f.select('container'); control(f, 'execute').handlers.click(); await settle() }
function confirm(f) { const input = control(f, 'restart-confirm'); input.checked = true; input.handlers.change() }

test('stored update jobs keep lookup IDs across read errors, explicit new starts and reload without replay', async t => {
  const { value, fixedPlan } = executable(), storage = storeFixture(), sent = []
  const unreadable = () => Object.assign(Error('EACCES'), { status: 503, code: 'UNREADABLE', path: '/state/jobs/record.json', reason: 'EACCES' })
  let readError = true
  const api = async (path, options) => {
    if (path === '/api/updates') return value
    if (path.endsWith('/plans')) return { plan: fixedPlan }
    if (path === '/api/updates/operations') {
      sent.push(JSON.parse(options.body))
      if (sent.length === 1) throw unreadable()
      return { operation: receipt(fixedPlan, sent.at(-1).requestId) }
    }
    const requestId = path.split('/').at(-1)
    if (readError && requestId === sent[0].requestId) throw unreadable()
    return { operation: receipt(fixedPlan, requestId, readError ? 'applying' : 'completed') }
  }
  const f = fixture(t, api, storage)
  await obtainPlan(f); confirm(f)
  const button = control(f, 'execute'); button.handlers.click(); button.handlers.click(); await settle()
  assert.equal(sent.length, 1)
  assert.match(text(f.get('[data-update-product]')), /UNREADABLE \/ EACCES \/ \/state\/jobs\/record.json/)
  assert.equal(JSON.parse(storage.getItem(requestKey)).requestId, sent[0].requestId)
  assert.doesNotMatch(text(f.get('[data-update-product]')), /結果不明|結果確認不能|状態: failed/)
  await f.center.refresh()
  assert.equal(sent.length, 1)
  control(f, 'execute').handlers.click(); await settle(); confirm(f)
  control(f, 'execute').handlers.click(); await settle()
  assert.equal(sent.length, 2)
  const saved = JSON.parse(storage.getItem(requestKey))
  assert.equal(saved.requestId, sent[1].requestId)
  assert.deepEqual(saved.previous[0], { requestId: sent[0].requestId, planId: fixedPlan.planId })
  f.center.close(); readError = false
  const reloaded = fixture(t, api, storage)
  await reloaded.center.start()
  assert.match(text(reloaded.get('[data-update-product]')), /状態: ready/)
  assert.equal(JSON.parse(storage.getItem(requestKey)).requestId, sent[1].requestId)
  assert.ok(reloaded.calls.some(([path]) => path.endsWith(sent[0].requestId)))
  assert.ok(reloaded.calls.some(([path]) => path.endsWith(sent[1].requestId)))
  assert.ok(reloaded.calls.every(([, options]) => !options?.method))
  assert.equal(sent.length, 2)
  await reloaded.center.refresh({ type: 'updates', error: { code: 'UNREADABLE', message: 'EIO', path: '/state/jobs/sse.json', reason: 'EIO' } })
  assert.match(text(reloaded.get('[data-update-product]')), /UNREADABLE \/ EIO \/ \/state\/jobs\/sse.json/)
  assert.match(text(reloaded.get('[data-update-product]')), /状態: ready/)
  await reloaded.center.refresh()
  assert.doesNotMatch(text(reloaded.get('[data-update-product]')), /EIO/)
})

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
  assert.match(text(f.get('[data-update-detail]')), /状態: queued/)
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
  assert.match(text(reloaded.get('[data-update-detail]')), /状態: ready/)
  assert.equal(JSON.parse(storage.getItem(requestKey)).requestId, sent.requestId)
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
  assert.ok(storage.getItem(requestKey))
  assert.match(text(f.get('[data-update-detail]')), /更新情報を取得できませんでした/)
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

test('update SSE bypasses a blocked ordinary view and refreshes current jobs independently of history', async t => {
  const { createWebClient } = await import('../web/client.js')
  const { readFile } = await import('node:fs/promises')
  const vm = await import('node:vm')
  const source = await readFile(new URL('../web/application.js', import.meta.url), 'utf8')
  const eventFunctions = source.slice(source.indexOf('function eventAffectsTimeline('), source.indexOf('function conversationKey('))
  const { value, fixedPlan } = executable(), storage = storeFixture()
  const requestId = '10000000-0000-4000-8000-000000000000', oldId = '20000000-0000-4000-8000-000000000000'
  const jobId = '30000000-0000-4000-8000-000000000000'
  const initial = receipt(fixedPlan, requestId)
  initial.jobs = [storedJob(jobId, 'queued')]
  value.operation = initial; value.jobs = initial.jobs
  storage.setItem(requestKey, JSON.stringify({ requestId, planId: fixedPlan.planId,
    previous: [{ requestId: oldId, planId: fixedPlan.planId }] }))
  const historical = deferred(), slowInventory = deferred(), ordinary = deferred()
  let blockInventory = false, eventStream, inventoryReads = 0, oldReads = 0
  let inventoryActive = 0, maxInventoryActive = 0, blocked = false
  const calls = [], ordered = [], errors = []
  const f = fixture(t, async path => {
    calls.push(path)
    if (path === '/api/updates') {
      inventoryReads++; inventoryActive++; maxInventoryActive = Math.max(maxInventoryActive, inventoryActive)
      try { return structuredClone(blockInventory ? await slowInventory.promise : value) }
      finally { inventoryActive-- }
    }
    if (path.endsWith(oldId)) { oldReads++; return historical.promise }
    if (path.endsWith(requestId)) return { operation: structuredClone(value.operation) }
    assert.fail(`Unexpected API ${path}`)
  }, storage)
  const started = f.center.start()
  await settle()
  f.select('container')
  assert.match(text(f.get('[data-update-product]')), /状態: queued/)
  const client = createWebClient({ fetch: async () => new Response(new ReadableStream({ start(controller) { eventStream = controller } })) })
  const context = vm.createContext({ state: {}, watchEvents: client.watchEvents, updateCenter: f.center,
    ownerDialog: { open: false }, goals: { refreshOnEvent() {} },
    loadBots: async () => { ordered.push('begin'); blocked = true; await ordinary.promise; ordered.push('end') },
    loadMessages: async () => {}, allSchedules: { refresh() {} }, scheduleEditor: { refresh() {} },
    conversationComposer: { showError: message => errors.push(message) },
  })
  vm.runInContext(eventFunctions, context)
  await context.connectEvents()
  const emit = payload => eventStream.enqueue(new TextEncoder().encode(`data:${JSON.stringify(payload)}\n\n`))
  const rows = () => text(f.get('[data-update-components]'))
  emit({ type: 'timeline', all: false, topics: ['timeline'], botIds: ['other'], roomIds: [] })
  await settle(); assert.equal(blocked, true)
  emit({ type: 'timeline', all: false, topics: ['timeline'], botIds: ['other'], roomIds: [] })
  blockInventory = true
  const downloading = { ...initial.jobs[0], state: 'downloading', updatedAtNs: '1794000000000000000' }
  emit({ type: 'updates', all: false, jobs: [downloading] })
  await settle()
  assert.match(text(f.get('[data-update-product]')), /状態: downloading/)
  assert.match(text(f.get('[data-update-detail]')), /状態: downloading/)
  const ready = { ...downloading, state: 'ready', updatedAtNs: '1794000000000000001' }
  value.operation = { ...initial, phase: 'completed', execution: 'succeeded', verification: 'succeeded', jobs: [ready] }
  value.jobs = [ready]
  value.components[0].current = structuredClone(value.components[0].published)
  value.components[0].comparison = { state: 'up_to_date', reason: null }
  value.components[0].capability = { supported: false, reason: 'UPDATE_ALREADY_CURRENT' }
  for (let i = 0; i < 4; i++) emit({ type: 'updates', all: false, jobs: [ready] })
  await settle()
  assert.match(text(f.get('[data-update-product]')), /状態: ready/)
  assert.match(text(f.get('[data-update-detail]')), /状態: ready/)
  assert.deepEqual(ordered, ['begin'], 'ordinary view is still waiting')
  assert.equal(oldReads, 1, 'blocked history is not fetched concurrently')
  blockInventory = false; slowInventory.resolve(structuredClone(value))
  await settle(); await settle()
  assert.match(rows(), /正式公開版と一致.*更新は不要/)
  assert.match(text(f.get('[data-update-detail]')), /現在稼働.*bbbbbbbbbbbb/)
  assert.doesNotMatch(text(f.get('[data-update-product]')), /状態: queued|状態: downloading/)
  assert.ok(inventoryReads <= 3, 'invalidations coalesce into a trailing inventory read')
  assert.equal(maxInventoryActive, 1)
  value.components[0].capability = { supported: false, reason: 'MODULE_EXCHANGE_BUSY' }
  const refreshing = f.center.refresh()
  await settle()
  assert.match(rows(), /ほかの更新を実行中/)
  assert.doesNotMatch(rows(), /更新に必要な条件を確認できない/)
  assert.ok(calls.every(path => path === '/api/updates' || path.startsWith('/api/updates/operations/')))
  ordinary.resolve(); historical.resolve({ operation: receipt(fixedPlan, oldId, 'completed') })
  await started; await refreshing; await settle()
  assert.deepEqual(ordered, ['begin', 'end', 'begin', 'end'], 'ordinary notifications retain their order')
  assert.deepEqual(errors, [])
  context.state.stopEvents()
})

test('refresh button asks for the catalog check first and still reads when the check is rejected', async t => {
  const f = fixture(t, async path => {
    if (path === '/api/updates/catalog-check') throw Object.assign(Error('HOST_UPDATE_ARGUMENTS'), { status: 503 })
    return inventory()
  })
  await f.center.start(); f.calls.length = 0
  f.get('[data-update-refresh]').handlers.click(); await settle(); await settle()
  assert.deepEqual(f.calls.map(([path, options]) => [path, options?.method]), [['/api/updates/catalog-check', 'POST'], ['/api/updates', undefined]])
  assert.equal(f.get('[data-update-components]').children.length, 2)
})
