import assert from 'node:assert/strict'
import test from 'node:test'
import { createUpdateCenter, validGatewayRelease } from '../web/update-center.js'
import { webDOM } from './helpers/web-dom.mjs'
import { deferred } from './helpers/editor-dom.mjs'

const digest = 'a'.repeat(64)
const settle = () => new Promise(resolve => setImmediate(resolve))
const text = node => [node.textContent ?? '', ...node.children.map(text)].join(' ')
function fixture(t, api) {
  const dom = webDOM(t), root = dom.get('update-center'), calls = []
  const opener = dom.get('update-open')
  const center = createUpdateCenter({ root, buttons: [opener], api: async (...args) => { calls.push(args); return api(...args) } })
  return { root, calls, center, open: () => opener.handlers.click(), get: selector => root.querySelector(selector), select(id) {
    root.querySelector('[data-update-components]').children.find(node => node.dataset.component === id).handlers.click()
  } }
}

test('gateway public snapshot rejects unknown states and missing/malformed versions', () => {
  assert.equal(validGatewayRelease({ currentVersionId: null, update: null }), true)
  for (const status of ['accepted', 'running', 'succeeded', 'failed', 'not_started'])
    assert.equal(validGatewayRelease({ currentVersionId: digest, update: { versionId: digest, status } }), true)
  for (const value of [null, {}, [], { currentVersionId: '1.2.3', update: null }, { currentVersionId: digest },
    { currentVersionId: digest, update: { versionId: digest, status: 'completed' } }]) assert.equal(validGatewayRelease(value), false)
})

test('review UI reads real current only, separates module impact, and never issues a mutation', async t => {
  const f = fixture(t, async path => {
    if (path === '/api/web-gateway-release') return { webGatewayRelease: { currentVersionId: digest, update: { versionId: digest, status: 'succeeded' } } }
    throw Object.assign(Error(), { status: 404 })
  })
  assert.equal(f.calls.length, 0)
  f.open(); await settle()
  assert.match(f.get('[data-update-notice]').textContent, /レビュー用/)
  assert.match(text(f.get('[data-update-components]')), /aaaaaaaaaaaa/)
  f.select('notifications')
  assert.match(text(f.get('[data-update-detail]')), /会話の保存とAIの処理は継続/)
  assert.doesNotMatch(text(f.get('[data-update-detail]')), /全Botの会話と処理が一時中断/)
  f.select('core')
  assert.match(text(f.get('[data-update-detail]')), /全Botの会話と処理が一時中断/)
  f.select('all')
  assert.match(text(f.get('[data-update-detail]')), /再起動が必要とは限りません/)
  f.select('web-gateway')
  assert.match(text(f.get('[data-update-detail]')), /交換機構の成功を確認/)
  assert.match(text(f.get('[data-update-detail]')), /実稼働確認は未接続/)
  assert.doesNotMatch(text(f.get('[data-update-detail]')), /更新完了/)
  const action = f.get('[data-update-detail]').children.find(node => node.className === 'update-execute')
  assert.equal(action.disabled, true)
  assert.ok(f.calls.every(([, options]) => !options?.method || options.method === 'GET'))
})

test('auth and invalid responses stay unavailable; late and disposed reads never overwrite newer state', async t => {
  const first = deferred()
  let reads = 0
  const f = fixture(t, async path => {
    if (path.includes('notifications')) throw Object.assign(Error(), { status: 403 })
    if (++reads === 1) return first.promise
    return { webGatewayRelease: { currentVersionId: digest, update: null } }
  })
  f.open(); const newer = f.center.refresh(); await newer
  first.resolve({ webGatewayRelease: { currentVersionId: 'b'.repeat(64), update: null } }); await settle()
  assert.match(text(f.get('[data-update-components]')), /aaaaaaaaaaaa/)
  assert.doesNotMatch(text(f.get('[data-update-components]')), /bbbbbbbbbbbb/)
  f.select('notifications')
  assert.match(text(f.get('[data-update-detail]')), /権限がありません/)
  const count = f.calls.length
  f.center.close(); await f.center.refresh()
  assert.equal(f.calls.length, count)
})
