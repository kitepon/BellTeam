import assert from 'node:assert/strict'
import test from 'node:test'
import { createUpdateCenter, validUpdateInventory } from '../web/update-center.js'
import { updateModuleExamples, validateUpdateRequest } from '../src/update-center-contract.mjs'
import { webDOM } from './helpers/web-dom.mjs'
import { deferred } from './helpers/editor-dom.mjs'

const settle = () => new Promise(resolve => setImmediate(resolve))
const text = node => [node.textContent ?? '', ...node.children.map(text)].join(' ')
const find = (node, name) => node.dataset?.updateControl === name ? node : node.children.map(child => find(child, name)).find(Boolean)
const key = 'bellteam-update-request.v1'
const storage = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) } }
function example(name = 'module_update') {
  const value = structuredClone(updateModuleExamples[name]), plan = value.operation.plan
  plan.expiresAt = new Date(Date.now() + 300000).toISOString()
  value.plans = []; value.operation = null; value.previousOperation = null
  for (const component of value.components) {
    const target = plan.targets.find(target => target.componentId === component.id)
    component.current = structuredClone(target.current); component.published = structuredClone(target.published)
    component.comparison = { state: 'update_available', reason: null }
    component.capability = { supported: true, reason: null }
  }
  return { value, plan }
}
const operation = (plan, id, phase = 'applying') => ({ requestId: id, plan, admission: 'accepted', phase,
  execution: phase === 'completed' ? 'succeeded' : phase === 'unknown' ? 'unknown' : 'pending',
  verification: phase === 'completed' ? 'succeeded' : phase === 'unknown' ? 'unknown' : 'pending', error: null, reference: id })
function fixture(t, api, saved = storage()) {
  const dom = webDOM(t), root = dom.get('update-center'), calls = []
  const center = createUpdateCenter({ root, buttons: [dom.get('update-open')], storage: saved, api: async (path, options) => {
    calls.push({ path, body: options?.body ? JSON.parse(options.body) : null }); return api(path, options)
  } })
  const detail = () => root.querySelector('[data-update-detail]')
  return { center, calls, saved, detail, control: name => find(detail(), name), select: id => root.querySelector('[data-update-components]').children.find(node => node.dataset.component === id).handlers.click() }
}

test('module UI consumes the fixed examples and rejects invalid action or target bindings', () => {
  for (const value of Object.values(updateModuleExamples)) assert.equal(validUpdateInventory(value), true)
  for (const change of [plan => { plan.action = 'shell' }, plan => { plan.targets = [] }, plan => { plan.componentId = 'members' },
    plan => { plan.targets.push(plan.targets[0]) }, plan => { plan.scope = 'all'; plan.componentId = null; plan.action = 'rollback' }]) {
    const value = structuredClone(updateModuleExamples.module_update); change(value.operation.plan)
    assert.equal(validUpdateInventory(value), false)
  }
})

test('module UI sends the explicit individual plan and one old-shape operation without restart confirmation', async t => {
  const { value, plan } = example(), accepted = deferred()
  let input
  const f = fixture(t, async (path, options) => {
    if (path === '/api/updates') return value
    if (path.endsWith('/plans')) { const body = JSON.parse(options.body); validateUpdateRequest('plan', body); assert.deepEqual(body, { scope: 'component', componentId: 'notifications' }); return { plan } }
    if (path.endsWith('/operations')) { input = JSON.parse(options.body); validateUpdateRequest('operation', input); return accepted.promise }
    return { operation: operation(plan, input.requestId) }
  })
  await f.center.start(); f.select('notifications'); f.control('execute').handlers.click(); await settle()
  assert.equal(f.control('restart-confirm'), undefined)
  assert.equal(f.control('execute').disabled, false)
  const submit = f.control('execute'); submit.handlers.click(); submit.handlers.click(); await settle()
  assert.equal(f.calls.filter(call => call.path === '/api/updates/operations').length, 1)
  assert.deepEqual(Object.keys(input).sort(), ['confirmContainerRestart', 'planId', 'requestId'])
  assert.equal(input.confirmContainerRestart, false)
  assert.equal(JSON.parse(f.saved.getItem(key)).requestId, input.requestId)
  accepted.resolve({ operation: operation(plan, input.requestId) }); await settle()
  assert.match(text(f.detail()), /受付済み/)
  assert.ok(f.calls.some(call => call.path.endsWith(input.requestId)))
})

test('module UI asks backend for rollback even without update capability and uses its builtin target', async t => {
  const { value, plan } = example('module_rollback')
  value.components[0].comparison = { state: 'up_to_date', reason: null }
  value.components[0].capability = { supported: false, reason: 'UPDATE_EXECUTOR_UNAVAILABLE' }
  let result
  const f = fixture(t, async (path, options) => {
    if (path === '/api/updates') return value
    if (path.endsWith('/plans')) { assert.deepEqual(JSON.parse(options.body), { scope: 'component', componentId: 'notifications', action: 'rollback' }); return { plan } }
    if (path.endsWith('/operations')) { const body = JSON.parse(options.body); result = operation(plan, body.requestId, 'completed') }
    return { operation: result }
  })
  await f.center.start(); f.select('notifications')
  assert.equal(f.control('execute').disabled, true)
  assert.equal(f.control('rollback').disabled, false)
  f.control('rollback').handlers.click(); await settle()
  assert.match(text(f.detail()), /固定した戻し先.*内蔵版/)
  assert.match(text(f.detail()), /現在のデータ・設定・更新履歴は巻き戻しません/)
  assert.equal(f.control('execute').textContent, 'この計画で戻す')
  assert.equal(f.control('execute').disabled, false)
  f.control('execute').handlers.click(); await settle()
  assert.match(text(f.detail()), /戻し完了/)
  assert.equal(f.saved.getItem(key), null)
})

test('module UI displays all fixed targets in order and asks restart confirmation only when the plan requires it', async t => {
  for (const restart of [false, true]) {
    const { value, plan } = example('all_modules'); plan.impact.containerRestart = restart
    value.operation = operation({ ...plan, planId: '33333333-3333-4333-8333-333333333333' }, '22222222-2222-4222-8222-222222222222', 'completed')
    let input
    const f = fixture(t, async (path, options) => {
      if (path === '/api/updates') return value
      if (path.endsWith('/plans')) { assert.deepEqual(JSON.parse(options.body), { scope: 'all' }); return { plan } }
      if (path.endsWith('/operations')) input = JSON.parse(options.body)
      return { operation: operation(plan, input.requestId) }
    })
    await f.center.start(); f.control('execute').handlers.click(); await settle()
    const body = text(f.detail())
    assert.match(body, /表示中の計画はまだ実行していません/)
    assert.match(body, /Web受付:.*通知:.*メンバーと予定:/)
    assert.ok(body.indexOf('Web受付 · 固定した更新先') < body.indexOf('通知 · 固定した更新先'))
    assert.ok(body.indexOf('通知 · 固定した更新先') < body.indexOf('メンバーと予定 · 固定した更新先'))
    assert.equal(f.control('rollback'), undefined)
    assert.equal(f.control('execute').disabled, restart)
    if (restart) { const check = f.control('restart-confirm'); check.checked = true; check.handlers.change() }
    else assert.equal(f.control('restart-confirm'), undefined)
    f.control('execute').handlers.click(); await settle()
    assert.equal(input.confirmContainerRestart, restart)
    assert.equal(f.calls.filter(call => call.path === '/api/updates/operations').length, 1)
    f.center.close()
  }
})

test('module UI keeps an unknown rollback UUID across reload and reads it despite inventory failure', async t => {
  const { value, plan } = example('module_rollback'), saved = storage()
  let input, completed = false
  const api = async (path, options) => {
    if (path === '/api/updates') { if (completed) throw Object.assign(Error(), { status: 503 }); return value }
    if (path.endsWith('/plans')) return { plan }
    if (path.endsWith('/operations')) { input = JSON.parse(options.body); throw new TypeError('response lost') }
    assert.equal(path, '/api/updates/operations/' + input.requestId)
    return { operation: operation(plan, input.requestId, completed ? 'completed' : 'unknown') }
  }
  const first = fixture(t, api, saved)
  await first.center.start(); first.select('notifications'); first.control('rollback').handlers.click(); await settle()
  first.control('execute').handlers.click(); await settle()
  assert.ok(saved.getItem(key)); assert.match(text(first.detail()), /結果を確認できません/)
  await first.center.refresh(); assert.equal(first.calls.filter(call => call.path === '/api/updates/operations').length, 1)
  first.center.close()
  const reloaded = fixture(t, api, saved); await reloaded.center.start()
  assert.ok(saved.getItem(key)); assert.equal(reloaded.control('execute').disabled, true)
  completed = true; await reloaded.center.refresh()
  assert.match(text(reloaded.detail()), /戻し完了/)
  assert.equal(saved.getItem(key), null)
  assert.ok(reloaded.calls.every(call => call.body === null))
})

test('module UI rejects a plan for another action or target and ignores a response after target selection changes', async t => {
  for (const change of [plan => { plan.action = 'rollback' }, plan => { plan.componentId = 'members'; plan.targets[0].componentId = 'members' }]) {
    const { value, plan } = example(); change(plan)
    const f = fixture(t, async path => path.endsWith('/plans') ? { plan } : value)
    await f.center.start(); f.select('notifications'); f.control('execute').handlers.click(); await settle()
    assert.doesNotMatch(f.control('execute').textContent, /この計画/)
    assert.equal(f.calls.filter(call => call.path === '/api/updates/operations').length, 0)
    f.center.close()
  }
  const { value, plan } = example(), pending = deferred()
  const f = fixture(t, async path => path.endsWith('/plans') ? pending.promise : value)
  await f.center.start(); f.select('notifications'); f.control('execute').handlers.click(); f.select('all')
  pending.resolve({ plan }); await settle()
  assert.doesNotMatch(f.control('execute').textContent, /この計画/)
  assert.equal(f.calls.filter(call => call.path === '/api/updates/operations').length, 0)
})

test('module UI explains backend rollback rejection or missing artifacts without starting a worker', async t => {
  for (const [code, message] of [['UPDATE_ROLLBACK_UNAVAILABLE', /戻せる直前の個別更新を確認できません/], ['RELEASE_NOT_INSTALLED', /配置されていません/]]) {
    const { value } = example()
    const f = fixture(t, async path => { if (path.endsWith('/plans')) throw Object.assign(new Error(code), { status: 409 }); return value })
    await f.center.start(); f.select('notifications'); f.control('rollback').handlers.click(); await settle()
    assert.match(text(f.detail()), message)
    assert.match(text(f.detail()), new RegExp(code))
    assert.equal(f.calls.filter(call => call.path === '/api/updates/operations').length, 0)
    f.select('all'); assert.equal(f.control('rollback'), undefined)
    f.center.close()
  }
})

test('module UI never executes an expired or incompatible all plan or an operation whose action changed', async t => {
  const { value, plan } = example('all_modules'); plan.compatibility.compatible = false
  const f = fixture(t, async path => path.endsWith('/plans') ? { plan } : value)
  await f.center.start(); f.control('execute').handlers.click(); await settle()
  assert.equal(f.control('execute').disabled, true)
  f.control('execute').handlers.click(); await settle()
  assert.equal(f.calls.filter(call => call.path === '/api/updates/operations').length, 0)
  plan.compatibility.compatible = true; plan.expiresAt = new Date(Date.now() - 1000).toISOString()
  f.control('replan').handlers.click(); await settle()
  assert.doesNotMatch(f.control('execute').textContent, /この計画/)
  assert.equal(f.calls.filter(call => call.path === '/api/updates/operations').length, 0)
  f.center.close()
  const one = example('module_rollback'); let input
  const g = fixture(t, async (path, options) => {
    if (path === '/api/updates') return one.value
    if (path.endsWith('/plans')) return { plan: one.plan }
    if (path.endsWith('/operations')) input = JSON.parse(options.body)
    return { operation: operation({ ...one.plan, action: 'update' }, input.requestId, 'completed') }
  })
  await g.center.start(); g.select('notifications'); g.control('rollback').handlers.click(); await settle()
  g.control('execute').handlers.click(); await settle()
  assert.ok(g.saved.getItem(key)); assert.doesNotMatch(text(g.detail()), /戻し完了/)
  assert.equal(g.calls.filter(call => call.path === '/api/updates/operations').length, 1)
})
