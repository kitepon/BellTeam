import assert from 'node:assert/strict'
import test from 'node:test'
import { createUpdateCenter, validUpdateInventory } from '../web/update-center.js'
import { updateExamples, updateComponents, validateUpdates } from '../src/update-center-contract.mjs'
import { webDOM } from './helpers/web-dom.mjs'
import { deferred } from './helpers/editor-dom.mjs'

const settle = () => new Promise(resolve => setImmediate(resolve))
const text = node => [node.textContent ?? '', ...node.children.map(text)].join(' ')
const inventory = () => structuredClone(updateExamples.published_unavailable)
function fixture(t, api) {
  const dom = webDOM(t), root = dom.get('update-center'), calls = []
  const opener = dom.get('update-open')
  const center = createUpdateCenter({ root, buttons: [opener], api: async (...args) => { calls.push(args); return api(...args) } })
  return { root, calls, center, open: () => opener.handlers.click(), get: selector => root.querySelector(selector), select(id) {
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
  assert.match(text(f.get('[data-update-detail]')), /端末への通知は設定されていません/)
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
    if (name === 'accepted') assert.match(body, /受付済み.*実行: 未確認.*稼働確認: 未確認/)
    if (name === 'disconnected_unknown') assert.match(body, /結果確認不能/)
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
