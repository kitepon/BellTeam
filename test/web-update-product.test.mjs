import test from 'node:test'
import assert from 'node:assert/strict'
import { createUpdateCenter } from '../web/update-center.js'
import { updateModuleExamples, updateExamples } from '../src/update-center-contract.mjs'
import { webDOM } from './helpers/web-dom.mjs'
const settle = () => new Promise(resolve => setImmediate(resolve))
const text = node => [node.textContent ?? '', ...node.children.map(text)].join(' ')
const find = (node, name) => node.dataset?.updateControl === name ? node : node.children.map(child => find(child, name)).find(Boolean)
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
const operation = (plan, id, phase = 'completed') => ({ plan, requestId: id, admission: 'accepted', phase, execution: phase === 'completed' ? 'succeeded' : 'unknown', verification: phase === 'completed' ? 'succeeded' : 'unknown', error: null, reference: id })
function fixture(t, value, plan, { old = null, loseGet = false, failSave = false } = {}) {
  const dom = webDOM(t), root = dom.get('update-center'), product = root.querySelector('[data-update-product]'), calls = [], data = new Map()
  if (old) { value.operation = old; data.set(key, JSON.stringify({ requestId: old.requestId, planId: old.plan.planId })) }
  let accepted
  const center = createUpdateCenter({ root, buttons: [dom.get('update-open')], storage: { getItem: key => data.get(key) ?? null, setItem(key, value) { if (failSave) throw Error('storage'); data.set(key, value) }, removeItem: key => data.delete(key) }, api: async (path, options) => {
    calls.push({ path, body: options?.body ? JSON.parse(options.body) : null })
    if (path === '/api/updates?runtime=1') return value
    if (path.endsWith('/plans')) return { plan }
    if (path === '/api/updates/operations') { accepted = operation(plan, JSON.parse(options.body).requestId); return { operation: accepted } }
    if (loseGet) throw Error('offline')
    return { operation: path.endsWith(old?.requestId) ? old : accepted }
  } })
  return { center, product, calls, data, control: name => find(product, name), text: () => text(product) }
}

test('standard view has a single primary, genuine changes, and no component table or technical values', async t => {
  const { value, plan } = example(), f = fixture(t, value, plan)
  await f.center.start()
  assert.match(f.text(), /更新があります.*画面の文字を読みやすく/)
  assert.doesNotMatch(f.text(), /commit|[a-f0-9]{32}|UUID|protocol|内蔵版|公開版/)
  assert.equal(f.product.children.filter(node => node.tagName === 'BUTTON' || node.dataset?.updateControl === 'primary').length, 1)
  assert.equal(f.control('primary').textContent, '更新する')
  assert.equal(f.calls.filter(call => call.body).length, 0)
  value.components[0].changes = []; await f.center.refresh()
  assert.doesNotMatch(f.text(), /変更内容|届いて|未供給/)
})

test('one candidate requests one fixed plan, then explicit Start exactly once; no automatic follow-up', async t => {
  const { value, plan } = example(), f = fixture(t, value, plan)
  await f.center.start(); f.control('primary').handlers.click(); await settle()
  assert.match(f.text(), /更新内容を確認/)
  assert.equal(f.calls.filter(call => call.path.endsWith('/plans')).length, 1)
  assert.equal(f.calls.filter(call => call.path === '/api/updates/operations').length, 0)
  const action = f.control('execute'); action.handlers.click(); action.handlers.click(); await settle()
  assert.equal(f.calls.filter(call => call.path === '/api/updates/operations').length, 1)
  assert.match(f.text(), /更新しました/)
  assert.doesNotMatch(f.text(), /最新の状態です/)
})

test('multiple candidates require one selection before planning and never synthesize an all request', async t => {
  const { value, plan } = example(); value.components.push({ ...structuredClone(value.components[0]), id: 'memory', name: '記憶' })
  const f = fixture(t, value, plan); await f.center.start(); f.control('primary').handlers.click()
  assert.match(f.text(), /更新する項目を選択/)
  assert.equal(f.calls.filter(call => call.body).length, 0)
  f.control('choose-' + plan.componentId).handlers.click(); await settle()
  const sent = f.calls.find(call => call.path.endsWith('/plans')).body
  assert.deepEqual(sent, { scope: 'component', componentId: plan.componentId })
})

test('restart impact requires the existing explicit checkbox before Start', async t => {
  const { value, plan } = example(true), f = fixture(t, value, plan)
  await f.center.start(); f.control('primary').handlers.click(); await settle()
  assert.equal(f.control('execute').disabled, true)
  assert.match(f.text(), /一時中断/)
  f.control('execute').handlers.click(); await settle()
  assert.equal(f.calls.filter(call => call.path === '/api/updates/operations').length, 0)
  const checkbox = f.control('restart-confirm'); checkbox.checked = true; checkbox.handlers.change()
  assert.equal(f.control('execute').disabled, false)
  f.control('execute').handlers.click(); await settle()
  assert.equal(f.calls.find(call => call.path === '/api/updates/operations').body.confirmContainerRestart, true)
})

test('old unknown keeps its UUID, GET-only primary and explicit new-plan path; failed GET stops Start', async t => {
  const { value, plan } = example(); const oldPlan = structuredClone(plan); oldPlan.planId = '11111111-1111-4111-8111-111111111111'
  const old = operation(oldPlan, '22222222-2222-4222-8222-222222222222', 'unknown')
  const f = fixture(t, value, plan, { old, loseGet: true }); await f.center.start()
  assert.match(f.text(), /結果を確認中/); assert.equal(f.control('primary').textContent, '状況を確認')
  assert.doesNotMatch(f.text(), /記録を保持|要求ID|UUID/)
  f.control('primary').handlers.click(); await settle()
  assert.ok(f.data.get(key).includes(old.requestId)); assert.equal(f.calls.filter(call => call.body).length, 0)
  f.control('choose').handlers.click(); f.control('choose-' + plan.componentId).handlers.click(); await settle()
  assert.equal(f.calls.filter(call => call.path.endsWith('/plans')).length, 0)
})

test('save failure and unsupported plan are visible and never send Start', async t => {
  const { value, plan } = example(), f = fixture(t, value, plan, { failSave: true })
  await f.center.start(); f.control('primary').handlers.click(); await settle(); f.control('execute').handlers.click(); await settle()
  assert.match(f.text(), /開始できませんでした/); assert.equal(f.calls.filter(call => call.path === '/api/updates/operations').length, 0)
  plan.capability = { supported: false, reason: 'UPDATE_EXECUTOR_UNAVAILABLE' }; await f.center.refresh()
  assert.equal(f.control('execute').disabled, true)
})

test('running updates offer only a state GET and never issue a plan or Start', async t => {
  const { value, plan } = example()
  value.operation = { ...operation(plan, '22222222-2222-4222-8222-222222222222'), phase: 'applying', execution: 'pending', verification: 'pending' }
  const f = fixture(t, value, plan); await f.center.start()
  assert.match(f.text(), /更新しています/); assert.equal(f.control('primary').textContent, '状況を確認')
  f.control('primary').handlers.click(); await settle()
  assert.equal(f.calls.filter(call => call.body).length, 0)
})

test('successful GET of an old unknown allows an explicit new plan while retaining the old IDs and result', async t => {
  const { value, plan } = example(), oldPlan = structuredClone(plan)
  oldPlan.planId = '55555555-5555-4555-8555-555555555555'
  const old = operation(oldPlan, '22222222-2222-4222-8222-222222222222', 'unknown')
  const f = fixture(t, value, plan, { old }); await f.center.start()
  f.control('choose').handlers.click(); f.control('choose-' + plan.componentId).handlers.click(); await settle()
  assert.equal(f.calls.filter(call => call.path.endsWith('/plans')).length, 1)
  f.control('execute').handlers.click(); await settle()
  const sent = f.calls.find(call => call.path === '/api/updates/operations').body
  assert.notEqual(sent.requestId, old.requestId)
  const held = JSON.parse(f.data.get(key)); assert.deepEqual(held.previous, [old])
  assert.equal(f.calls.filter(call => call.path === '/api/updates/operations').length, 1)
  assert.ok(f.calls.some(call => call.path.endsWith(old.requestId)))
})
