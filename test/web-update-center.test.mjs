import assert from 'node:assert/strict'
import test from 'node:test'
import { createUpdateCenter, validUpdateInventory } from '../web/update-center.js'
import { updateExamples, updateComponents, runtimeUpdateComponents, validateUpdates } from '../src/update-center-contract.mjs'
import { webDOM } from './helpers/web-dom.mjs'
import { deferred } from './helpers/editor-dom.mjs'

const settle = () => new Promise(resolve => setImmediate(resolve))
const text = node => [node.textContent ?? '', ...node.children.map(text)].join(' ')
const inventory = () => structuredClone(updateExamples.published_unavailable)
// The whole dialog: normal cards plus 詳細 (detail and toolbar notice), where raw records and codes live.
const whole = f => ['[data-update-notice]', '[data-update-product]', '[data-update-detail]'].map(selector => text(f.get(selector))).join(' ')
const cards = f => { const found = []; const walk = node => { if (node.className === 'update-card') found.push(node); node.children.forEach(walk) }; walk(f.get('[data-update-product]')); return found }
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
  const rows = () => f.get('[data-update-detail]').children.find(node => node.className === 'update-release-notes update-problems')
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
  assert.ok(f.calls.every(([path, options]) => path === '/api/updates?runtime=1' && !options?.method))
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
  assert.deepEqual(f.calls, [['/api/updates?runtime=1']])
  assert.equal(f.get('[data-update-components]').children.length, updateComponents.length + 1)
  f.select('members')
  assert.match(text(f.get('[data-update-detail]')), /個別更新に対応していません/)
  f.select('notifications')
  assert.match(text(f.get('[data-update-detail]')), /内蔵版 · bbbbbbbbbbbb/)
  assert.match(text(f.get('[data-update-detail]')), /通知が未設定のため、端末へのお知らせを送れません/)
  assert.match(text(f.get('[data-update-detail]')), /実行機構は未接続/)
  const action = f.get('[data-update-detail]').children.find(node => node.className === 'update-execute')
  assert.equal(action.disabled, true)
  assert.ok(f.calls.every(([path, options]) => path === '/api/updates?runtime=1' && !options?.method))
})

const storedJob = (jobId, state = 'queued', moduleId = 'container') => ({
  schema: 'bellteam.update-job.v1', jobId, idempotencyKey: jobId,
  kind: moduleId === 'container' ? 'container' : 'module',
  target: { catalogSha256: 'c'.repeat(64), moduleId, versionId: 'b'.repeat(64) }, state,
  reason: state === 'failed' ? { code: 'READY_PROBE_FAILED', message: '実際の応答を確認できませんでした。<img src=x>' } : null,
  transitions: [{ state, atNs: '1793999999999999999' }], updatedAtNs: '1793999999999999999',
})

test('component status uses exact server lines and actions while technical history stays in details', async t => {
  const value = inventory(), base = value.components[0]
  const old = storedJob('10000000-0000-4000-8000-000000000000', 'failed')
  const succeeded = storedJob('20000000-0000-4000-8000-000000000000', 'ready')
  const failed = storedJob('30000000-0000-4000-8000-000000000000', 'failed', 'notifications')
  const latest = record => ({ jobId: record.jobId, kind: record.kind, state: record.state,
    outcome: record.state === 'ready' ? 'succeeded' : 'failed', at: '2026-11-08T00:45:00Z', reason: record.reason })
  value.components = [
    { ...base, status: { line: '内蔵版です。更新はありません。11/08 09:45 JSTに更新しました。',
      tone: 'ok', actionRequired: false, action: null, latestJob: latest(succeeded) } },
    { ...structuredClone(base), id: 'notifications', name: '通知', status: {
      line: '現在利用できません。11/08 09:45 JSTの更新を完了できませんでした。<img src=x>',
      tone: 'attention', actionRequired: true, action: '通知の設定を確認してください。', latestJob: latest(failed) } },
  ]
  value.jobs = [old, succeeded, failed]
  value.problems = [{ fingerprint: 'a'.repeat(64), status: 'open', kind: 'module_restart_limit', moduleId: 'notifications',
    count: 5, windowSeconds: 1800, lastExit: { code: 1, signal: null }, lastReason: 'READY_PROBE_FAILED' }]
  let offline = false
  const f = fixture(t, async () => { if (offline) throw Error('UNREADABLE_PRIVATE_CODE'); return value })
  await f.center.start()
  const product = () => text(f.get('[data-update-product]'))
  assert.equal(validUpdateInventory(value), true)
  assert.equal(cards(f).length, 2)
  assert.deepEqual(cards(f).map(card => card.dataset.component), value.components.map(component => component.id))
  assert.match(text(cards(f)[0]), /確認できません.*最終更新/)
  assert.equal(cards(f)[1].dataset.tone, 'danger'); assert.match(text(cards(f)[1]), /要対応/)
  assert.match(product(), /対応が必要です.*通知の設定を確認してください。/)
  assert.doesNotMatch(product(), /ジョブID|状態:|failed|READY_PROBE_FAILED|10000000-|20000000-|30000000-|直近の終了コード|<img/)
  f.select('container')
  assert.match(text(f.get('[data-update-detail]')), new RegExp(succeeded.jobId))
  assert.match(text(f.get('[data-update-detail]')), /状態の説明.*内蔵版です。.*最新ジョブ日時.*JST/)
  assert.match(text(f.get('[data-update-detail]')), /状態: 失敗.*READY_PROBE_FAILED/)
  f.select('notifications')
  assert.match(text(f.get('[data-update-detail]')), new RegExp(failed.jobId))
  assert.match(text(f.get('[data-update-detail]')), /READY_PROBE_FAILED/)
  value.components[1].status = { line: '更新を実行しています。', tone: 'updating', actionRequired: false, action: null, latestJob: null }
  await f.center.refresh({ type: 'updates', jobs: [old] })
  assert.doesNotMatch(product(), /要対応|通知の設定を確認|更新を完了できません|READY_PROBE_FAILED/)
  offline = true
  await f.center.refresh({ type: 'updates', jobs: [failed] })
  assert.doesNotMatch(product(), /UNREADABLE_PRIVATE_CODE|READY_PROBE_FAILED|30000000-|状態: 失敗/)
  assert.match(text(f.get('[data-update-notice]')), /UNREADABLE_PRIVATE_CODE/)
  offline = false
  for (const component of value.components) delete component.status
  await f.center.refresh()
  assert.match(whole(f), /保存されたジョブ.*状態: 失敗.*READY_PROBE_FAILED/)
  assert.doesNotMatch(product(), /READY_PROBE_FAILED/)
  assert.equal(validUpdateInventory(value), true)
  for (const status of [null, {}, { line: '確認', tone: 'invalid', actionRequired: false, action: null, latestJob: null },
    { line: '確認', tone: 'ok', actionRequired: false, action: null, latestJob: { ...latest(succeeded), at: 'invalid' } }]) {
    assert.equal(validUpdateInventory({ ...value, components: [{ ...base, status }] }), true)
  }
  assert.ok(f.calls.every(([path, options]) => path === '/api/updates?runtime=1' && !options?.method))
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
  const product = f.get('[data-update-detail]'), body = text(product)
  for (const record of records) {
    assert.match(body, new RegExp(`状態: ${({ queued: '順番待ち', downloading: '取り込み中', verifying: '確認中', swapping: '切り替え中', ready: '完了', failed: '失敗' })[record.state]}`))
    assert.match(body, new RegExp(record.jobId))
  }
  const rows = product.children.find(node => node.className === 'update-release-notes update-jobs').children.slice(1)
  assert.equal(rows.length, 6)
  assert.match(body, /実際の応答を確認できませんでした。<img src=x>/) // the message as text; the code sits under サポート用の詳細 (W63)
  assert.match(body, /READY_PROBE_FAILED/)
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
  assert.ok(f.calls.every(([path, options]) => path === '/api/updates?runtime=1' && !options?.method))
  offline = true
  await f.center.refresh({ type: 'updates', jobs: [records[5]] })
  assert.match(whole(f), /NETWORK_READ_FAILED.*状態: 失敗.*READY_PROBE_FAILED/)
  assert.doesNotMatch(text(f.get('[data-update-product]')), /状態: unknown|結果不明/)
  const storage = storeFixture(), historical = structuredClone(value.operation)
  storage.setItem(requestKey, JSON.stringify({ previous: [historical] }))
  const restored = fixture(t, async path => {
    if (path === '/api/updates?runtime=1') return value
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

test('runtime rows opt in, retain next-launch policy and use single-target jobs without restart or rollback', async t => {
  const { value, fixedPlan } = executable(), storage = storeFixture()
  const base = value.components[0], policy = '次回起動から適用。実行中の席は現在の版を継続'
  value.components = runtimeUpdateComponents.map(([id, name, description]) => ({ ...structuredClone(base), id, name, description,
    runtimeApplication: { generationId: id === 'runtime-codex' ? 'a'.repeat(64) : null, policy: 'next_launch' },
    capability: id === 'runtime-aiterm-mcp' ? { supported: false, reason: 'AITERM_EXCLUSIVE_SCOPE_UNAVAILABLE' } : { supported: true, reason: null } }))
  fixedPlan.componentId = 'runtime-codex'
  fixedPlan.targets = [{ ...fixedPlan.targets[0], componentId: fixedPlan.componentId }]
  fixedPlan.impact = { containerRestart: false, description: policy }
  value.operation = null; value.previousOperation = null
  let accepted = null, sent = null
  const f = fixture(t, async (path, options) => {
    if (path === '/api/updates?runtime=1') return value
    if (path === '/api/updates/plans') {
      assert.deepEqual(JSON.parse(options.body), { scope: 'component', componentId: 'runtime-codex' })
      return { plan: fixedPlan }
    }
    if (path === '/api/updates/operations') {
      sent = JSON.parse(options.body)
      accepted = receipt(fixedPlan, sent.requestId)
      accepted.jobs[0] = { ...storedJob(sent.requestId, 'queued', fixedPlan.componentId), kind: 'runtime' }
      value.operation = accepted; value.jobs = accepted.jobs
      return { operation: accepted }
    }
    assert.equal(path, '/api/updates/operations/' + sent.requestId)
    return { operation: accepted }
  }, storage)
  await f.center.start()
  assert.deepEqual(f.calls, [['/api/updates?runtime=1']])
  assert.equal(validUpdateInventory(value), true)
  assert.equal(validateUpdates(value).valid, true)
  for (const row of f.get('[data-update-components]').children.slice(1)) assert.ok(text(row).includes(policy))
  for (const [id] of runtimeUpdateComponents) {
    f.select(id)
    assert.ok(text(f.get('[data-update-detail]')).includes(policy))
    assert.equal(control(f, 'rollback'), undefined)
    assert.equal(control(f, 'restart-confirm'), undefined)
    assert.doesNotMatch(text(f.get('[data-update-detail]')), /戻し|戻す|巻き戻/)
  }
  f.select('runtime-aiterm-mcp')
  assert.match(text(f.get('[data-update-detail]')), /AITERM_EXCLUSIVE_SCOPE_UNAVAILABLE/)
  assert.equal(control(f, 'execute').disabled, true)
  f.select('runtime-codex')
  assert.match(text(f.get('[data-update-detail]')), /現在稼働.*正式公開版/)
  control(f, 'execute').handlers.click(); await settle()
  assert.equal(control(f, 'restart-confirm'), undefined)
  assert.equal(control(f, 'execute').disabled, false)
  assert.ok(text(f.get('[data-update-product]')).includes(policy))
  assert.doesNotMatch(text(f.get('[data-update-product]')), /戻し|戻す|巻き戻/)
  control(f, 'execute').handlers.click(); await settle()
  assert.equal(sent.confirmContainerRestart, false)
  assert.equal(sent.planId, fixedPlan.planId)
  assert.equal(f.calls.filter(([path]) => path === '/api/updates/operations').length, 1)
  assert.equal(JSON.parse(storage.getItem(requestKey)).requestId, sent.requestId)
  assert.match(whole(f), /状態: 順番待ち/)
  assert.match(text(f.get('[data-update-detail]')), /状態: 順番待ち/)
  accepted.jobs[0] = { ...accepted.jobs[0], state: 'ready', updatedAtNs: '1794000000000000000' }
  value.jobs = accepted.jobs
  // Runtime records are absent from public SSE; the opted-in GET supplies their actual state.
  await f.center.refresh({ type: 'updates', jobs: [] })
  assert.match(whole(f), /状態: 完了/)
  assert.match(text(f.get('[data-update-detail]')), /状態: 完了/)
  assert.equal(validUpdateInventory(value), true)
  for (const runtimeApplication of [undefined, { generationId: 'bad', policy: 'next_launch' }, { generationId: null, policy: 'now' }]) {
    assert.equal(validUpdateInventory({ ...value, components: [{ ...value.components[0], runtimeApplication }] }), false)
  }
})

test('a newer optional status falls back per row without disabling components or blocking plan and start', async t => {
  const { value, fixedPlan } = executable(), storage = storeFixture()
  const first = value.components[0]
  first.status = { line: 'この部品の説明は新しい形式です。', tone: 'future_tone', actionRequired: false, action: null,
    latestJob: { kind: 'future_kind', reason: { future: true } } }
  value.components.push({ ...structuredClone(first), id: 'notifications', name: '通知', status: {
    line: '通知は利用できます。更新があります。', tone: 'ok', actionRequired: false, action: null, latestJob: null } })
  for (const component of value.components) component.capability = { supported: true, reason: null }
  let accepted = null
  const f = fixture(t, async (path, options) => {
    if (path === '/api/updates?runtime=1') return value
    if (path.endsWith('/plans')) return { plan: fixedPlan }
    if (path.endsWith('/operations')) {
      const body = JSON.parse(options.body)
      accepted = receipt(fixedPlan, body.requestId)
      value.operation = accepted
      return { operation: accepted }
    }
    return { operation: accepted }
  }, storage)
  await f.center.start()
  assert.equal(validUpdateInventory(value), true)
  const product = f.get('[data-update-product]')
  assert.equal(cards(f).length, 2)
  assert.match(text(cards(f)[0]), new RegExp(`更新あり.*${first.name}`))
  assert.match(text(cards(f)[1]), /通知/)
  assert.doesNotMatch(text(product), /新しい形式|future_|応答形式/)
  for (const component of value.components) {
    f.select(component.id)
    assert.equal(control(f, 'execute').disabled, false)
  }
  f.select('container')
  control(f, 'execute').handlers.click(); await settle()
  confirm(f)
  control(f, 'execute').handlers.click(); await settle()
  assert.equal(f.calls.filter(([path]) => path === '/api/updates/operations').length, 1)
  assert.equal(accepted.admission, 'accepted')
})

test('stored update jobs keep lookup IDs across read errors, explicit new starts and reload without replay', async t => {
  const { value, fixedPlan } = executable(), storage = storeFixture(), sent = []
  const unreadable = () => Object.assign(Error('EACCES'), { status: 503, code: 'UNREADABLE', path: '/state/jobs/record.json', reason: 'EACCES' })
  let readError = true
  const api = async (path, options) => {
    if (path === '/api/updates?runtime=1') return value
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
  assert.match(whole(f), /UNREADABLE \/ EACCES \/ \/state\/jobs\/record.json/)
  assert.equal(JSON.parse(storage.getItem(requestKey)).requestId, sent[0].requestId)
  assert.doesNotMatch(text(f.get('[data-update-product]')), /結果不明|結果確認不能|状態: 失敗/)
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
  assert.match(whole(reloaded), /状態: 完了/)
  assert.equal(JSON.parse(storage.getItem(requestKey)).requestId, sent[1].requestId)
  assert.ok(reloaded.calls.some(([path]) => path.endsWith(sent[0].requestId)))
  assert.ok(reloaded.calls.some(([path]) => path.endsWith(sent[1].requestId)))
  assert.ok(reloaded.calls.every(([, options]) => !options?.method))
  assert.equal(sent.length, 2)
  await reloaded.center.refresh({ type: 'updates', error: { code: 'UNREADABLE', message: 'EIO', path: '/state/jobs/sse.json', reason: 'EIO' } })
  assert.match(whole(reloaded), /UNREADABLE \/ EIO \/ \/state\/jobs\/sse.json/)
  assert.match(whole(reloaded), /状態: 完了/)
  await reloaded.center.refresh()
  assert.doesNotMatch(text(reloaded.get('[data-update-product]')), /EIO/)
})

test('container plan needs explicit restart confirmation, freezes target and submits one canonical request', async t => {
  const { value, fixedPlan } = executable(), storage = storeFixture(), response = deferred()
  let accepted = null, body = null
  const f = fixture(t, async (path, options) => {
    if (path === '/api/updates?runtime=1') return value
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
  assert.match(text(f.get('[data-update-detail]')), /状態: 順番待ち/)
  assert.doesNotMatch(text(f.get('[data-update-detail]')), /更新完了/)
  assert.ok(f.calls.some(([path]) => path === '/api/updates/operations/' + body.requestId))
})

test('lost POST response survives reload and catalog outage; recovery only reads the identical request', async t => {
  const { value, fixedPlan } = executable(), storage = storeFixture()
  let sent, completed = false
  const api = async (path, options) => {
    if (path === '/api/updates?runtime=1') { if (completed) throw Object.assign(Error(), { status: 503 }); return value }
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
  assert.match(text(reloaded.get('[data-update-detail]')), /状態: 完了/)
  assert.equal(JSON.parse(storage.getItem(requestKey)).requestId, sent.requestId)
  assert.ok(reloaded.calls.every(([, options]) => !options?.method))
  assert.ok(reloaded.calls.some(([path]) => path.endsWith(sent.requestId)))
})

test('409 rejects the old plan without a retry, and expired plans cannot start', async t => {
  const { value, fixedPlan } = executable(), storage = storeFixture()
  const f = fixture(t, async path => {
    if (path === '/api/updates?runtime=1') return value
    if (path.endsWith('/plans')) return { plan: fixedPlan }
    // The same-ID read proves nothing was stored under the new ID.
    if (path.startsWith('/api/updates/operations/')) throw Object.assign(Error('UPDATE_OPERATION_NOT_FOUND'), { status: 404, code: 'UPDATE_OPERATION_NOT_FOUND' })
    throw Object.assign(Error(), { status: 409 })
  }, storage)
  await obtainPlan(f); confirm(f); control(f, 'execute').handlers.click(); await settle()
  // 409 + the lookup's UPDATE_OPERATION_NOT_FOUND = definitely not admitted: the new ID is not kept.
  assert.equal(storage.getItem(requestKey), null)
  assert.match(whole(f), /受け付けられませんでした/)
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
  const wrong = fixture(t, async path => path === '/api/updates?runtime=1' ? value : { operation: receipt(fixedPlan, '33333333-3333-4333-8333-333333333333', 'completed') }, storage)
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
    if (path === '/api/updates?runtime=1') return value
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
    if (path === '/api/updates?runtime=1') {
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
  assert.match(whole(f), /状態: 順番待ち/)
  const client = createWebClient({ fetch: async () => new Response(new ReadableStream({ start(controller) { eventStream = controller } })) })
  const context = vm.createContext({ state: {}, watchEvents: client.watchEvents, updateCenter: f.center,
    ownerDialog: { open: false }, goals: { refreshOnEvent() {} },
    loadBots: async () => { ordered.push('begin'); blocked = true; await ordinary.promise; ordered.push('end') },
    loadMessages: async () => {}, allSchedules: { refresh() {} }, scheduleEditor: { refresh() {} },
    conversationComposer: { showError: message => errors.push(message) },
    reconnectPill: { hidden: true }, showBanner: message => { if (message) errors.push(message) },
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
  assert.match(whole(f), /状態: 取り込み中/)
  assert.match(text(f.get('[data-update-detail]')), /状態: 取り込み中/)
  const ready = { ...downloading, state: 'ready', updatedAtNs: '1794000000000000001' }
  value.operation = { ...initial, phase: 'completed', execution: 'succeeded', verification: 'succeeded', jobs: [ready] }
  value.jobs = [ready]
  value.components[0].current = structuredClone(value.components[0].published)
  value.components[0].comparison = { state: 'up_to_date', reason: null }
  value.components[0].capability = { supported: false, reason: 'UPDATE_ALREADY_CURRENT' }
  for (let i = 0; i < 4; i++) emit({ type: 'updates', all: false, jobs: [ready] })
  await settle()
  assert.match(whole(f), /状態: 完了/)
  assert.match(text(f.get('[data-update-detail]')), /状態: 完了/)
  assert.deepEqual(ordered, ['begin'], 'ordinary view is still waiting')
  assert.equal(oldReads, 1, 'blocked history is not fetched concurrently')
  blockInventory = false; slowInventory.resolve(structuredClone(value))
  await settle(); await settle()
  assert.match(rows(), /正式公開版と一致.*更新は不要/)
  assert.match(text(f.get('[data-update-detail]')), /現在稼働.*bbbbbbbbbbbb/)
  assert.doesNotMatch(text(f.get('[data-update-product]')), /状態: 順番待ち|状態: 取り込み中/)
  assert.ok(inventoryReads <= 3, 'invalidations coalesce into a trailing inventory read')
  assert.equal(maxInventoryActive, 1)
  value.components[0].capability = { supported: false, reason: 'MODULE_EXCHANGE_BUSY' }
  const refreshing = f.center.refresh()
  await settle()
  assert.match(rows(), /ほかの更新を実行中/)
  assert.doesNotMatch(rows(), /更新に必要な条件を確認できない/)
  assert.ok(calls.every(path => path === '/api/updates?runtime=1' || path.startsWith('/api/updates/operations/')))
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
  assert.deepEqual(f.calls.map(([path, options]) => [path, options?.method]), [['/api/updates/catalog-check', 'POST'], ['/api/updates?runtime=1', undefined]])
  assert.equal(f.get('[data-update-components]').children.length, 2)
})

test('entry label and part list count only non-runtime update_available rows', async t => {
  const { value } = executable(), base = value.components[0]
  const product = { ...structuredClone(base), comparison: { state: 'up_to_date', reason: null } }
  const runtime = runtimeUpdateComponents.map(([id, name, description]) => ({ ...structuredClone(base), id, name, description,
    comparison: { state: 'update_available', reason: null }, runtimeApplication: { generationId: null, policy: 'next_launch' } }))
  const usage = { ...structuredClone(base), id: 'usage', name: 'usage', comparison: { state: 'unavailable', reason: 'UPDATE_MODULE_CATALOG_INVALID' } }
  value.components = [product, usage, ...runtime]
  // Production shape (Trony 2026-11-10): every published row carries a verified publication check.
  const publication = { catalog: { sha256: 'c'.repeat(64), publishedAt: '2026-11-10T01:20:59Z', expiresAt: '2026-12-10T01:20:59Z' },
    check: { status: 'verified', checkedAt: '2026-11-10T02:04:18Z', error: null } }
  for (const row of value.components) row.publication = structuredClone(publication)
  value.notice = { state: 'ready', code: null, message: 'ok' }
  value.operation = null; value.previousOperation = null
  const f = fixture(t, async () => value)
  await f.center.start()
  assert.equal(validUpdateInventory(value), true)
  assert.equal(f.opener.hidden, true)
  const rows = f.get('[data-update-components]').children.slice(1)
  assert.ok(rows.every(row => !text(row).includes('更新あり')))
  for (const row of rows.filter(row => row.dataset.component.startsWith('runtime-'))) assert.ok(text(row).includes('本体と一緒に更新'))
  product.comparison = { state: 'update_available', reason: null }
  await f.center.refresh()
  assert.equal(f.opener.hidden, false)
  assert.equal(f.opener.textContent, '更新 1件')
})

test('incompatible usage with every other part latest is named and asks for no action', async t => {
  const { value } = executable(), base = value.components[0]
  const product = { ...structuredClone(base), comparison: { state: 'up_to_date', reason: null } }
  const runtime = runtimeUpdateComponents.map(([id, name, description]) => ({ ...structuredClone(base), id, name, description,
    comparison: { state: 'update_available', reason: null }, runtimeApplication: { generationId: null, policy: 'next_launch' } }))
  // Trony 2026-11-10, body a5cd9272: usage has no version for this body (incompatible), everything else 最新.
  const usage = { ...structuredClone(base), id: 'usage', name: '利用設定', comparison: { state: 'incompatible', reason: null } }
  value.components = [product, usage, ...runtime]
  value.notice = { state: 'ready', code: null, message: 'ok' }
  value.operation = null; value.previousOperation = null
  const f = fixture(t, async () => value)
  await f.center.start()
  const header = text(f.get('[data-update-product]'))
  assert.match(header, /更新できるものはすべて最新です/)
  assert.match(header, /利用設定は、いまの本体に合う版がまだありません。合う版が出ると、ここで更新できます。/)
  assert.doesNotMatch(header, /確認できません|「更新」を押してください/)
})
