import test from 'node:test'
import assert from 'node:assert/strict'
import { aiControlView, validAiControl } from '../web/ai-control.js'

const value = (state = 'enabled') => ({ paused: state !== 'enabled', state, updatedAt: null, unconfirmedBotIds: [], commandsConfirmed: state === 'stopped' ? true : null, error: null })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function elements() {
  const make = () => ({ handlers: {}, addEventListener(name, handler) { this.handlers[name] = handler }, emit(name) { return this.handlers[name]() } })
  const toggle = make(), status = make(), button = make()
  return { toggle, status, button, root: { querySelector: selector => selector === 'input' ? toggle : selector === 'button' ? button : status } }
}

test('Webは正本が読めるまでトグルを隠し、失敗後に古い値を表示しない', async () => {
  const f = elements(); let fail = false
  const view = aiControlView(f.root, async () => { if (fail) throw Error('offline'); return { control: value('stopped') } })
  assert.equal(f.toggle.hidden, true); assert.equal(f.toggle.disabled, true)
  await view.refresh(); assert.equal(f.toggle.checked, true); assert.equal(f.toggle.hidden, false)
  fail = true; await view.refresh()
  assert.equal(f.toggle.hidden, true); assert.equal(f.toggle.disabled, true)
  assert.match(f.status.textContent, /状態を確認できません/)
})

test('Webは通信断や502/503でPATCHを再送せずGETで正本を読み直す', async () => {
  for (const status of [null, 502, 503]) {
    const f = elements(), calls = []; let changed = false
    const view = aiControlView(f.root, async (_path, options) => {
      calls.push(options?.method ?? 'GET')
      if (options?.method === 'PATCH') { changed = true; throw Object.assign(Error('fixture'), { status }) }
      return { control: value(changed ? 'unconfirmed' : 'enabled') }
    })
    await view.refresh(); f.toggle.checked = true; await f.toggle.emit('change')
    assert.deepEqual(calls, ['GET', 'PATCH', 'GET'])
    assert.equal(f.toggle.checked, true); assert.match(f.status.textContent, /一部/)
  }
})

test('Webは202相当の処理中を停止完了と表示せず、重複PATCHを抑止する', async () => {
  const f = elements(), patch = deferred(), calls = []
  let changed = false
  const view = aiControlView(f.root, async (_path, options) => {
    calls.push(options?.method ?? 'GET')
    if (options?.method === 'PATCH') { changed = true; await patch.promise }
    return { control: value(changed ? 'stopping' : 'enabled') }
  })
  await view.refresh(); f.toggle.checked = true
  const first = f.toggle.emit('change')
  assert.equal(f.toggle.disabled, true)
  await f.toggle.emit('change'); assert.equal(calls.filter(x => x === 'PATCH').length, 1)
  patch.resolve(); await first
  assert.match(f.status.textContent, /停止中/); assert.doesNotMatch(f.status.textContent, /停止を確認/)
})

test('Webは遅い旧GETを新しいGETより後に採用せず、矛盾する結果も採用しない', async () => {
  const f = elements(), old = deferred(); let sequence = 0
  const view = aiControlView(f.root, async () => ++sequence === 1 ? old.promise : { control: value('stopped') })
  const slow = view.refresh(); await view.refresh()
  old.resolve({ control: value() }); await slow
  assert.equal(f.toggle.checked, true)
  assert.equal(validAiControl({ ...value(), state: 'stopped' }), false)
  assert.equal(validAiControl({ ...value('stopped'), unconfirmedBotIds: ['bot-a'] }), false)
  assert.equal(validAiControl({ ...value('stopped'), commandsConfirmed: false }), false)
})
