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
// Every admitted operation carries its stored job records (Root job ledger contract 2026-11-07); legacy unknown has none.
const operation = (plan, id, phase = 'applying') => ({ requestId: id, plan, admission: 'accepted', phase,
  execution: phase === 'completed' ? 'succeeded' : phase === 'unknown' ? 'unknown' : 'pending',
  verification: phase === 'completed' ? 'succeeded' : phase === 'unknown' ? 'unknown' : 'pending', error: null, reference: id,
  ...(phase === 'unknown' ? {} : { jobs: plan.targets.map((target, index) => ({ schema: 'bellteam.update-job.v1', jobId: id.slice(0, -1) + index, idempotencyKey: id,
    kind: target.componentId === 'container' ? 'container' : 'module', target: { catalogSha256: 'c'.repeat(64), moduleId: target.componentId, versionId: 'b'.repeat(64) },
    state: phase === 'completed' ? 'ready' : 'swapping', reason: null, transitions: [], updatedAtNs: '1793999999999999999' })) }) })
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
    if (path === '/api/updates?runtime=1') return value
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
  assert.match(text(f.detail()), /状態: 切り替え中/) // the stored job record, not a legacy phase word
  assert.ok(f.calls.some(call => call.path.endsWith(input.requestId)))
})

test('module UI asks backend for rollback even without update capability and uses its builtin target', async t => {
  const { value, plan } = example('module_rollback')
  value.components[0].comparison = { state: 'up_to_date', reason: null }
  value.components[0].capability = { supported: false, reason: 'UPDATE_EXECUTOR_UNAVAILABLE' }
  let result
  const f = fixture(t, async (path, options) => {
    if (path === '/api/updates?runtime=1') return value
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
  assert.equal(f.control('execute').textContent, '確認して戻す')
  assert.equal(f.control('execute').disabled, false)
  f.control('execute').handlers.click(); await settle()
  assert.match(text(f.detail()), /状態: 完了/)
})

test('module UI displays all fixed targets in order and asks restart confirmation only when the plan requires it', async t => {
  for (const restart of [false, true]) {
    const { value, plan } = example('all_modules'); plan.impact.containerRestart = restart
    value.operation = operation({ ...plan, planId: '33333333-3333-4333-8333-333333333333' }, '22222222-2222-4222-8222-222222222222', 'completed')
    let input
    const f = fixture(t, async (path, options) => {
      if (path === '/api/updates?runtime=1') return value
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
    if (path === '/api/updates?runtime=1') { if (completed) throw Object.assign(Error(), { status: 503 }); return value }
    if (path.endsWith('/plans')) return { plan }
    if (path.endsWith('/operations')) { input = JSON.parse(options.body); throw new TypeError('response lost') }
    assert.equal(path, '/api/updates/operations/' + input.requestId)
    return { operation: operation(plan, input.requestId, completed ? 'completed' : 'unknown') }
  }
  const first = fixture(t, api, saved)
  await first.center.start(); first.select('notifications'); first.control('rollback').handlers.click(); await settle()
  first.control('execute').handlers.click(); await settle()
  assert.ok(saved.getItem(key)); assert.match(text(first.detail()), /保存されたジョブの記録はありません/)
  await first.center.refresh(); assert.equal(first.calls.filter(call => call.path === '/api/updates/operations').length, 1)
  first.center.close()
  const reloaded = fixture(t, api, saved); await reloaded.center.start()
  // The kept ID is read again after reload; a legacy unknown result adds no browser admission guard (job ledger contract).
  assert.ok(saved.getItem(key)); assert.ok(reloaded.calls.some(call => call.path.endsWith(input.requestId)))
  completed = true; await reloaded.center.refresh()
  assert.match(text(reloaded.detail()), /状態: 完了/)
  assert.equal(JSON.parse(saved.getItem(key)).requestId, input.requestId) // same-ID recovery stays possible after a terminal record
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
    if (path === '/api/updates?runtime=1') return one.value
    if (path.endsWith('/plans')) return { plan: one.plan }
    if (path.endsWith('/operations')) input = JSON.parse(options.body)
    return { operation: operation({ ...one.plan, action: 'update' }, input.requestId, 'completed') }
  })
  await g.center.start(); g.select('notifications'); g.control('rollback').handlers.click(); await settle()
  g.control('execute').handlers.click(); await settle()
  assert.ok(g.saved.getItem(key)); assert.doesNotMatch(text(g.detail()), /戻し完了/)
  assert.equal(g.calls.filter(call => call.path === '/api/updates/operations').length, 1)
})


const oldId = 'a860633b-e5c7-4dac-b5c2-6b0d39061bde'
const nextPlanId = '44444444-4444-4444-8444-444444444444'
function unknownExample() {
  const { value, plan } = example()
  const old = operation(structuredClone(plan), oldId, 'unknown')
  old.error = { code: 'HOST_UPDATE_BUSY', message: '前の要求の結果を確認できません。' }
  value.operation = old
  value.notice = { state: 'attention', code: 'HOST_UPDATE_BUSY', message: '保存された更新結果を確認してください。' }
  plan.planId = nextPlanId
  return { value, plan, old }
}

test('unknown UI retains old identities and results across explicit new execution and reload, with and without same-tab pending', async t => {
  for (const sameTab of [false, true]) {
    const { value, plan, old } = unknownExample(), saved = storage(), requests = [], oldBefore = structuredClone(old)
    if (sameTab) saved.setItem(key, JSON.stringify({ requestId: oldId, planId: old.plan.planId }))
    let next
    const api = async (path, options) => {
      if (path === '/api/updates?runtime=1') return value
      if (path.endsWith('/plans')) return { plan }
      if (path === '/api/updates/operations') {
        const input = JSON.parse(options.body); requests.push(input)
        assert.notEqual(input.requestId, oldId)
        next = operation(plan, input.requestId, 'completed')
        return { operation: next }
      }
      return { operation: path.endsWith(oldId) ? old : next }
    }
    const f = fixture(t, api, saved)
    await f.center.start(); f.select('notifications')
    assert.equal(f.control('execute').disabled, false)
    assert.equal(requests.length, 0)
    f.control('execute').handlers.click(); await settle()
    assert.match(text(f.detail()), /表示中の計画はまだ実行していません/)
    assert.equal(f.control('execute').textContent, '確認して更新する')
    assert.equal(requests.length, 0)
    const submit = f.control('execute'); submit.handlers.click(); submit.handlers.click(); await settle()
    assert.equal(requests.length, 1)
    assert.equal(requests[0].planId, nextPlanId)
    assert.equal(requests[0].confirmContainerRestart, false)
    // The new request stays current and the old one is kept as a reference (job ledger contract: history keeps IDs only).
    const kept = JSON.parse(saved.getItem(key))
    assert.equal(kept.requestId, requests[0].requestId); assert.deepEqual(kept.previous.map(entry => entry.requestId), [oldId])
    assert.deepEqual(old, oldBefore)
    assert.match(text(f.detail()), /保持している操作結果/)
    assert.match(text(f.detail()), new RegExp(oldId))
    f.center.close()
    const reloaded = fixture(t, api, saved)
    await reloaded.center.start()
    assert.ok(reloaded.calls.some(call => call.path.endsWith(oldId)))
    reloaded.select('notifications')
    assert.equal(reloaded.control('execute').disabled, false)
    reloaded.control(`read-${oldId}`).handlers.click(); await settle()
    assert.ok(reloaded.calls.filter(call => call.path.endsWith(oldId)).length >= 2)
    assert.equal(requests.length, 1)
    assert.deepEqual(JSON.parse(saved.getItem(key)).previous.map(entry => entry.requestId), [oldId])
    reloaded.center.close()
  }
})

// A kept unknown or still-applying old request is not a browser guard for any target (module, whole product, container):
// server capability and admission own concurrency (job ledger contract 2026-11-07). Only the server's capability blocks here.
test('unknown UI does not bypass a disabled capability', async t => {
  for (const condition of ['disabled']) {
    const { value, plan, old } = unknownExample(), saved = storage()
    if (condition === 'disabled') value.components[0].capability = { supported: false, reason: 'MODULE_EXCHANGE_BUSY' }
    if (condition === 'container') { value.components[0].id = 'container'; old.plan.componentId = 'container'; old.plan.targets[0].componentId = 'container' }
    saved.setItem(key, JSON.stringify({ requestId: oldId, planId: old.plan.planId }))
    const before = saved.getItem(key)
    const f = fixture(t, async path => path === '/api/updates?runtime=1' ? value : { operation: old }, saved)
    await f.center.start(); f.select(condition === 'container' ? 'container' : 'notifications')
    assert.equal(f.control('execute').disabled, true, condition)
    f.control('execute').handlers.click(); await settle()
    assert.ok(f.calls.every(call => call.body === null), condition)
    assert.equal(saved.getItem(key), before)
    f.center.close()
  }
})

// A failed or malformed read of the kept request is shown and keeps the request; it adds no browser admission guard.
test('unknown UI shows a failed, mismatched or malformed old-result GET, keeps the saved request and sends nothing by itself', async t => {
  for (const response of ['503', '404', 'wrong-id', 'wrong-plan', 'malformed']) {
    const { value, old } = unknownExample(), saved = storage()
    saved.setItem(key, JSON.stringify({ requestId: oldId, planId: old.plan.planId }))
    const before = saved.getItem(key)
    const f = fixture(t, async path => {
      if (path === '/api/updates?runtime=1') return value
      if (response === '503' || response === '404') throw Object.assign(Error('READ_FAILED'), { status: Number(response) })
      const result = structuredClone(old)
      if (response === 'wrong-id') result.requestId = nextPlanId
      if (response === 'wrong-plan') result.plan.planId = nextPlanId
      return { operation: response === 'malformed' ? {} : result }
    }, saved)
    await f.center.start(); f.select('notifications'); await settle()
    assert.equal(saved.getItem(key), before, response)
    assert.ok(f.calls.some(call => call.path.endsWith(oldId)), response)
    assert.match(text(f.detail()), /READ_FAILED|INVALID_OPERATION/, response)
    assert.ok(f.calls.every(call => call.body === null), response)
    f.center.close()
  }
})

test('unknown UI preserves old pending when a new plan is busy or saving the next request fails', async t => {
  for (const failure of ['plan-busy', 'storage']) {
    const { value, plan, old } = unknownExample(), saved = storage()
    saved.setItem(key, JSON.stringify({ requestId: oldId, planId: old.plan.planId }))
    const before = saved.getItem(key)
    const f = fixture(t, async path => {
      if (path === '/api/updates?runtime=1') return value
      if (path.endsWith('/plans')) {
        if (failure === 'plan-busy') throw Object.assign(Error('MODULE_EXCHANGE_BUSY'), { status: 409 })
        return { plan }
      }
      return { operation: old }
    }, saved)
    await f.center.start(); f.select('notifications'); f.control('execute').handlers.click(); await settle()
    if (failure === 'storage') {
      saved.setItem = () => { throw Error('QUOTA_EXCEEDED') }
      f.control('execute').handlers.click(); await settle()
      assert.match(text(f.detail()), /要求IDを保存できません/)
    } else assert.match(text(f.detail()), /計画を確認できませんでした/)
    assert.equal(saved.getItem(key), before)
    assert.equal(f.calls.filter(call => call.path === '/api/updates/operations').length, 0)
    f.center.close()
  }
})

test('unknown UI keeps retained results when their GET fails and reads them again on request', async t => {
  const { value, old } = unknownExample(), saved = storage()
  saved.setItem(key, JSON.stringify({ previous: [old] }))
  let unavailable = true
  const f = fixture(t, async path => {
    if (path === '/api/updates?runtime=1') return value
    if (unavailable) throw Object.assign(Error('READ_FAILED'), { status: 503 })
    return { operation: old }
  }, saved)
  await f.center.start(); f.select('notifications')
  assert.match(text(f.detail()), /保持している操作結果/)
  assert.deepEqual(JSON.parse(saved.getItem(key)).previous, [old])
  const reads = f.calls.filter(call => call.path.endsWith(oldId)).length
  unavailable = false; f.control(`read-${oldId}`).handlers.click(); await settle()
  assert.ok(f.calls.filter(call => call.path.endsWith(oldId)).length > reads)
  assert.deepEqual(JSON.parse(saved.getItem(key)).previous, [old])
  assert.equal(f.calls.filter(call => call.body !== null).length, 0)
})

test('unknown UI restores old history after a rejected new operation without resending either request', async t => {
  const { value, plan, old } = unknownExample(), saved = storage()
  saved.setItem(key, JSON.stringify({ requestId: oldId, planId: old.plan.planId }))
  const f = fixture(t, async path => {
    if (path === '/api/updates?runtime=1') return value
    if (path.endsWith('/plans')) return { plan }
    if (path === '/api/updates/operations') throw Object.assign(Error('MODULE_EXCHANGE_BUSY'), { status: 409 })
    if (!path.endsWith(oldId)) throw Object.assign(Error('UPDATE_OPERATION_NOT_FOUND'), { status: 404, code: 'UPDATE_OPERATION_NOT_FOUND' })
    return { operation: old }
  }, saved)
  await f.center.start(); f.select('notifications'); f.control('execute').handlers.click(); await settle()
  f.control('execute').handlers.click(); await settle()
  // 409 and the lookup proves nothing stored (UPDATE_OPERATION_NOT_FOUND): the new ID is dropped; the old one stays as a reference.
  assert.deepEqual(JSON.parse(saved.getItem(key)), { previous: [{ requestId: oldId, planId: old.plan.planId }] })
  assert.match(text(f.detail()), /受け付けられませんでした/)
  assert.equal(f.calls.filter(call => call.path === '/api/updates/operations').length, 1)
  assert.ok(f.calls.some(call => call.path.endsWith(oldId)))
})


test('unknown UI rejects reuse of the old plan and malformed retained storage', async t => {
  const { value, old } = unknownExample()
  const f = fixture(t, async path => path.endsWith('/plans') ? { plan: old.plan } : value)
  await f.center.start(); f.select('notifications'); f.control('execute').handlers.click(); await settle()
  assert.doesNotMatch(f.control('execute').textContent, /この計画/)
  assert.equal(f.calls.filter(call => call.path === '/api/updates/operations').length, 0)
  f.center.close()
  for (const previous of [[{}], [old, old]]) {
    const saved = storage(); saved.setItem(key, JSON.stringify({ previous }))
    const g = fixture(t, async () => value, saved)
    await g.center.start(); g.select('notifications')
    assert.equal(g.control('execute').disabled, true)
    assert.match(text(g.detail()), /保存された更新要求を確認できません/)
    assert.equal(g.calls.filter(call => call.body !== null).length, 0)
    g.center.close()
  }
})

test('unknown UI preserves multiple prior requests as kept history across a new operation', async t => {
  const { value, plan, old } = unknownExample(), saved = storage()
  const earlier = structuredClone(old); earlier.requestId = '55555555-5555-4555-8555-555555555555'
  earlier.plan.planId = '66666666-6666-4666-8666-666666666666'
  saved.setItem(key, JSON.stringify({ requestId: oldId, planId: old.plan.planId, previous: [earlier] }))
  let applyEarlier = false, next
  const f = fixture(t, async (path, options) => {
    if (path === '/api/updates?runtime=1') return value
    if (path.endsWith('/plans')) return { plan }
    if (path === '/api/updates/operations') { next = operation(plan, JSON.parse(options.body).requestId, 'completed'); return { operation: next } }
    return { operation: path.endsWith(oldId) ? old : path.endsWith(earlier.requestId) ? applyEarlier ? { ...earlier, phase: 'applying' } : earlier : next }
  }, saved)
  await f.center.start(); f.select('notifications'); f.control('execute').handlers.click(); await settle()
  f.control('execute').handlers.click(); await settle()
  assert.deepEqual(JSON.parse(saved.getItem(key)).previous, [earlier, { requestId: oldId, planId: old.plan.planId }])
  applyEarlier = true; await f.center.refresh()
  assert.deepEqual(JSON.parse(saved.getItem(key)).previous.map(result => result.requestId), [earlier.requestId, oldId])
  assert.equal(f.calls.filter(call => call.path === '/api/updates/operations').length, 1)
})

test('a 4xx after a step was admitted keeps the request ID; the same-ID lookup shows the stored job (job ledger contract)', async t => {
  const { value, plan } = example(), saved = storage()
  let input
  const f = fixture(t, async (path, options) => {
    if (path === '/api/updates?runtime=1') return value
    if (path.endsWith('/plans')) return { plan }
    if (path === '/api/updates/operations') { input = JSON.parse(options.body); throw Object.assign(Error('MODULE_EXCHANGE_BUSY'), { status: 409, code: 'MODULE_EXCHANGE_BUSY' }) }
    // The first step's receipt was persisted before the later step was refused.
    return { operation: { ...operation(plan, input.requestId), admission: 'pending' } }
  }, saved)
  await f.center.start(); f.select('notifications'); f.control('execute').handlers.click(); await settle()
  f.control('execute').handlers.click(); await settle()
  assert.equal(JSON.parse(saved.getItem(key)).requestId, input.requestId)
  assert.ok(f.calls.some(call => call.path === `/api/updates/operations/${input.requestId}`))
  assert.match(text(f.detail()), /状態: 切り替え中/)
  assert.equal(f.calls.filter(call => call.path === '/api/updates/operations').length, 1)
})

test('a 4xx whose lookup is not proof (5xx, a 404 without the not-found code) keeps the request ID', async t => {
  for (const failure of [Object.assign(Error('down'), { status: 503 }), Object.assign(Error('NOT_FOUND'), { status: 404, code: 'NOT_FOUND' })]) {
    const { value, plan } = example(), saved = storage()
    let input
    const f = fixture(t, async (path, options) => {
      if (path === '/api/updates?runtime=1') return value
      if (path.endsWith('/plans')) return { plan }
      if (path === '/api/updates/operations') { input = JSON.parse(options.body); throw Object.assign(Error('PLAN_STALE'), { status: 409 }) }
      throw failure
    }, saved)
    await f.center.start(); f.select('notifications'); f.control('execute').handlers.click(); await settle()
    f.control('execute').handlers.click(); await settle()
    assert.equal(JSON.parse(saved.getItem(key)).requestId, input.requestId, failure.message)
    f.center.close()
  }
})
