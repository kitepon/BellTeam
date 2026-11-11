import test from 'node:test'
import assert from 'node:assert/strict'
import { createUpdateCenter, cardState } from '../web/update-center.js'
import { updateModuleExamples, updateExamples } from '../src/update-center-contract.mjs'
import { componentStatus } from '../src/update-center.mjs'
import { webDOM } from './helpers/web-dom.mjs'
const settle = () => new Promise(resolve => setImmediate(resolve))
const text = node => [node.textContent ?? '', ...node.children.map(text)].join(' ')
const find = (node, name) => node.dataset?.updateControl === name ? node : node.children.map(child => find(child, name)).find(Boolean)
const all = (node, match) => [...(match(node) ? [node] : []), ...node.children.flatMap(child => all(child, match))]
const key = 'bellteam-update-request.v1'
function example(container = false) {
  const value = structuredClone(container ? updateExamples.accepted : updateModuleExamples.module_update), plan = value.operation.plan
  plan.expiresAt = new Date(Date.now() + 300000).toISOString()
  value.operation = null; value.previousOperation = null; value.plans = []
  const target = plan.targets[0]
  value.components = value.components.filter(item => item.id === target.componentId)
  const item = value.components[0]
  item.capability = { supported: true, reason: null }; item.comparison = { state: 'update_available', reason: null }
  item.changes = ['画面の文字を読みやすくしました。', 'commit ' + 'a'.repeat(40)]
  return { value, plan }
}
const job = (moduleId, state, minutesAgo, reason = null) => ({ schema: 'bellteam.update-job.v1', jobId: '44444444-4444-4444-8444-44444444444' + state.length % 10, kind: 'module', target: { moduleId },
  updatedAtNs: String(BigInt(Date.now() - minutesAgo * 60000) * 1000000n), state, reason })
const operation = (plan, id, phase = 'completed') => ({ plan, requestId: id, admission: 'accepted', phase, execution: phase === 'completed' ? 'succeeded' : 'unknown', verification: phase === 'completed' ? 'succeeded' : 'unknown', error: null, reference: id })
function fixture(t, value, plan, { old = null, failSave = false, failRead = false } = {}) {
  const dom = webDOM(t), root = dom.get('update-center'), product = root.querySelector('[data-update-product]'), calls = [], data = new Map()
  if (old) { value.operation = old; data.set(key, JSON.stringify({ requestId: old.requestId, planId: old.plan.planId })) }
  let accepted
  const center = createUpdateCenter({ root, buttons: [dom.get('update-open')], storage: { getItem: key => data.get(key) ?? null, setItem(key, value) { if (failSave) throw Error('storage'); data.set(key, value) }, removeItem: key => data.delete(key) }, api: async (path, options) => {
    calls.push({ path, body: options?.body ? JSON.parse(options.body) : null })
    if (path === '/api/updates?runtime=1') { if (failRead) throw Object.assign(Error('offline'), { code: 'NETWORK_DOWN' }); return value }
    if (path.endsWith('/plans')) return { plan }
    if (path === '/api/updates/operations') { accepted = operation(plan, JSON.parse(options.body).requestId); return { operation: accepted } }
    return { operation: path.endsWith(old?.requestId) ? old : accepted }
  } })
  return { center, product, calls, data, control: name => find(product, name), text: () => text(product), cards: () => all(product, node => node.className === 'update-card') }
}

test('cards show icon, name, version name, badge and time; one action only where an update exists; no hashes', async t => {
  const { value, plan } = example(); value.components.push({ ...structuredClone(value.components[0]), id: 'memory', name: '記憶', comparison: { state: 'up_to_date', reason: null }, capability: { supported: false, reason: 'UPDATE_ALREADY_CURRENT' }, changes: [] })
  const f = fixture(t, value, plan); await f.center.start()
  const [update, latest] = f.cards()
  assert.match(f.text(), /1つ更新できます/)
  assert.match(text(update), /更新あり.*新しい版あり.*画面の文字を読みやすく.*更新の記録なし/)
  assert.equal(all(update, node => node.className === 'update-card-icon')[0].dataset.icon, plan.componentId)
  assert.match(text(latest), /最新/)
  assert.doesNotMatch(text(update), /内蔵版/)
  assert.ok(find(update, 'card-' + plan.componentId)); assert.equal(all(latest, node => node.className === 'update-card-action').length, 0)
  assert.doesNotMatch(f.text(), /commit|[a-f0-9]{12,}|UUID|protocol/)
  assert.equal(f.calls.filter(call => call.body).length, 0)
})

test('version line shows a dated human name with the origin as a secondary word', async t => {
  const { value, plan } = example(), item = value.components[0], at = '2026-11-08T04:01:00Z'
  item.comparison = { state: 'up_to_date', reason: null }; item.capability = { supported: false, reason: 'UPDATE_ALREADY_CURRENT' }
  item.publication = { catalog: { sha256: 'a'.repeat(64), publishedAt: at, expiresAt: '2099-01-01T00:00:00Z' }, check: { status: 'verified', checkedAt: at, error: null } }
  const f = fixture(t, value, plan); await f.center.start()
  assert.match(text(f.cards()[0]), /11\/8 13:01 版/)
  assert.doesNotMatch(text(f.cards()[0]), /[a-f0-9]{7,}/)
})

test('card action requests one component plan, then explicit Start exactly once with a success banner', async t => {
  const { value, plan } = example(), f = fixture(t, value, plan)
  await f.center.start(); f.control('card-' + plan.componentId).handlers.click(); await settle()
  assert.match(f.text(), /を更新します/)
  assert.deepEqual(f.calls.find(call => call.path.endsWith('/plans')).body, { scope: 'component', componentId: plan.componentId })
  const action = f.control('execute'); action.handlers.click(); action.handlers.click(); await settle()
  assert.equal(f.calls.filter(call => call.path === '/api/updates/operations').length, 1)
  assert.match(f.text(), /更新しました/)
})

test('やめる clears the local plan and sends nothing', async t => {
  const { value, plan } = example(), f = fixture(t, value, plan)
  await f.center.start(); f.control('card-' + plan.componentId).handlers.click(); await settle()
  const before = f.calls.length; f.control('cancel').handlers.click()
  assert.equal(f.calls.length, before); assert.ok(f.control('card-' + plan.componentId)); assert.equal(f.control('execute'), undefined)
})

test('restart impact requires the existing explicit checkbox before Start', async t => {
  const { value, plan } = example(true), f = fixture(t, value, plan)
  await f.center.start(); f.control('card-' + plan.componentId).handlers.click(); await settle()
  assert.equal(f.control('execute').disabled, true); assert.match(f.text(), /一時中断/)
  f.control('execute').handlers.click(); await settle()
  assert.equal(f.calls.filter(call => call.path === '/api/updates/operations').length, 0)
  const checkbox = f.control('restart-confirm'); checkbox.checked = true; checkbox.handlers.change()
  f.control('execute').handlers.click(); await settle()
  assert.equal(f.calls.find(call => call.path === '/api/updates/operations').body.confirmContainerRestart, true)
})

test('badges follow the newest job and the server status: running with progress, failed, attention, latest', () => {
  const { value } = example(), base = value.components[0]
  const row = (comparison, available = true, jobs = []) => { const item = { ...structuredClone(base), comparison: { state: comparison, reason: null }, availability: { available, reason: null } }; return { ...item, status: componentStatus(item, jobs) } }
  const running = [job(base.id, 'downloading', 1)]
  assert.deepEqual([cardState(row('update_available', true, running), running).badge, cardState(row('update_available', true, running), running).step], ['更新中', 2])
  const failed = [job(base.id, 'failed', 5, { code: 'HOST_UPDATE_INSTALL_FAILED', message: 'x' })]
  assert.equal(cardState(row('update_available', true, failed), failed).badge, '失敗')
  // W60: the newest failed job reads 失敗 even on a serving, up-to-date part.
  assert.equal(cardState(row('up_to_date', true, failed), failed).badge, '失敗')
  assert.equal(cardState(row('update_available', false, failed), failed).badge, '要対応')
  assert.equal(cardState(row('up_to_date')).badge, '最新')
  // Owner rule: runtime parts update only with the body, so their badge is neutral, never an error.
  assert.deepEqual(['badge', 'tone'].map(key => cardState({ ...structuredClone(base), id: 'runtime-codex', comparison: { state: 'unavailable', reason: null } })[key]), ['本体と一緒に更新', 'neutral'])
  // Without status (older body) the badge comes from comparison and records only.
  assert.equal(cardState({ ...structuredClone(base), comparison: { state: 'update_available', reason: null } }).badge, '更新あり')
})

test('failures appear as a plain-words banner; codes stay out of the normal surface', async t => {
  const { value, plan } = example(), item = value.components[0]
  value.jobs = [job(item.id, 'failed', 5, { code: 'HOST_UPDATE_INSTALL_FAILED', message: 'install failed' })]
  item.availability = { available: false, reason: null }; item.status = componentStatus(item, value.jobs)
  const f = fixture(t, value, plan); await f.center.start()
  assert.match(f.text(), /対応が必要です/); assert.match(f.text(), /担当に伝えてください/)
  assert.doesNotMatch(f.text(), /HOST_UPDATE_INSTALL_FAILED|install failed|44444444/)
  const r = fixture(t, structuredClone(value), plan, { failRead: true }); await r.center.start()
  assert.match(r.text(), /更新情報を取得できません/); assert.ok(r.control('recheck')); assert.equal(r.control('retry'), undefined); assert.doesNotMatch(r.text(), /NETWORK_DOWN/)
})

test('a kept swap with a failed Aiterm state step says the new version runs and names the step', async t => {
  const { value, plan } = example(), item = value.components[0]
  value.jobs = [job(item.id, 'failed', 5, { code: 'HOST_UPDATE_AITERM_STATE_FAILED', message: 'x' })]
  item.comparison = { state: 'up_to_date', reason: null }; item.status = componentStatus(item, value.jobs)
  assert.equal(cardState(item, value.jobs).badge, '失敗')
  const f = fixture(t, value, plan); await f.center.start()
  assert.match(f.text(), /新しい版で動いていますが、席の状態を整える手順で失敗しました/); assert.doesNotMatch(f.text(), /元の版/)
})

test('save failure and unsupported plan are visible and never send Start', async t => {
  const { value, plan } = example(), f = fixture(t, value, plan, { failSave: true })
  await f.center.start(); f.control('card-' + plan.componentId).handlers.click(); await settle(); f.control('execute').handlers.click(); await settle()
  assert.match(f.text(), /更新を始められませんでした/); assert.equal(f.calls.filter(call => call.path === '/api/updates/operations').length, 0)
  plan.capability = { supported: false, reason: 'UPDATE_EXECUTOR_UNAVAILABLE' }
  f.control('cancel').handlers.click(); f.control('card-' + plan.componentId).handlers.click(); await settle()
  assert.equal(f.control('execute').disabled, true)
})

test('a new plan from a card keeps the old unknown request IDs and result', async t => {
  const { value, plan } = example(), oldPlan = structuredClone(plan)
  oldPlan.planId = '55555555-5555-4555-8555-555555555555'
  const old = operation(oldPlan, '22222222-2222-4222-8222-222222222222', 'unknown')
  const f = fixture(t, value, plan, { old }); await f.center.start()
  f.control('card-' + plan.componentId).handlers.click(); await settle()
  f.control('execute').handlers.click(); await settle()
  const sent = f.calls.find(call => call.path === '/api/updates/operations').body
  assert.notEqual(sent.requestId, old.requestId)
  assert.deepEqual(JSON.parse(f.data.get(key)).previous.map(entry => [entry.requestId, entry.planId ?? entry.plan.planId]), [[old.requestId, oldPlan.planId]])
  assert.ok(f.calls.some(call => call.path.endsWith(old.requestId)))
})
