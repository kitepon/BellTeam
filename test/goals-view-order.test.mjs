import assert from 'node:assert/strict'
import test from 'node:test'
import { goalsView } from '../web/goals.js'

// Independent response ordering, not native goal behavior. The actual module
// runs with a small DOM fixture so deferred reads/writes can be ordered exactly.
class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.events = {}; this.dataset = {}; this.textContent = ''; this.disabled = false }
  append(...nodes) { this.children.push(...nodes) }
  replaceChildren(...nodes) { this.children = [...nodes] }
  addEventListener(name, fn) { (this.events[name] ??= []).push(fn) }
  focus() {}
  showModal() {}
  all() { return [this, ...this.children.flatMap(node => node.all())] }
  querySelector(selector) { return this.parts?.[selector] ?? this.all().find(node => selector === 'textarea' && node.tagName === 'textarea') ?? null }
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const snapshot = (id, thread, status = 'active') => ({ botId: id, availability: 'available', binding: { sessionId: id, launchId: 'a'.repeat(32), threadId: thread }, capabilities: { edit: true, pause: true, resume: true, clear: true }, goal: { threadId: thread, objective: thread, status } })
function fixture(api, bots = ['a']) {
  globalThis.document = { createElement: tag => new Node(tag) }; globalThis.CSS = { escape: value => value }
  const dialog = new Node('dialog'), body = new Node('div'), notice = new Node('p'), refresh = new Node('button')
  dialog.parts = { '[data-goals-body]': body, '[data-goals-notice]': notice, '[data-goals-refresh]': refresh }
  const view = goalsView(dialog, api, () => bots.map(id => ({ id, name: id, harness: 'codex' })))
  const row = id => body.children.find(node => node.dataset.goalBot === id)
  const button = (id, text) => row(id)?.all().find(node => node.tagName === 'button' && node.textContent === text)
  const objective = id => row(id)?.all().find(node => node.className === 'goal-objective')?.textContent
  return { view, body, notice, refresh, row, button, objective }
}

test('a newer refresh cannot be rolled back by the old mutation response; pending is released', async () => {
  const held = deferred(); let current = snapshot('a', 'thread-A')
  const f = fixture(async (_path, options) => options?.method === 'POST' ? held.promise : { goals: [current] })
  await f.view.open(); const changing = f.button('a', '一時停止').events.click[0]()
  current = snapshot('a', 'thread-B'); await f.view.refresh()
  held.resolve({ outcome: 'confirmed', snapshot: snapshot('a', 'thread-A', 'paused') }); await changing
  assert.equal(f.objective('a'), 'thread-B'); assert.equal(f.button('a', '再開'), undefined)
  assert.equal(f.button('a', '一時停止').disabled, false)
})

test('failed mutation readback cannot overwrite a newer refresh or revive old controls', async () => {
  const readback = deferred(), reading = deferred(); let current = snapshot('a', 'thread-A')
  const f = fixture(async (path, options) => {
    if (options?.method === 'POST') throw Error('artificial response lost')
    if (path !== '/api/goals') { reading.resolve(); return readback.promise }
    return { goals: [current] }
  })
  await f.view.open(); const changing = f.button('a', '一時停止').events.click[0](); await reading.promise
  current = snapshot('a', 'thread-B'); await f.view.refresh()
  readback.resolve({ snapshot: snapshot('a', 'thread-A', 'paused') }); await changing
  assert.equal(f.objective('a'), 'thread-B'); assert.equal(f.button('a', '再開'), undefined)
  assert.equal(f.button('a', '一時停止').disabled, false)
})

test('independent member mutations apply in reverse response order and release only their own pending state', async () => {
  const a = deferred(), b = deferred()
  const f = fixture(async (path, options) => options?.method === 'POST' ? (path.includes('/a/') ? a.promise : b.promise) : { goals: [snapshot('a', 'A'), snapshot('b', 'B')] }, ['a', 'b'])
  await f.view.open(); const first = f.button('a', '一時停止').events.click[0](), second = f.button('b', '一時停止').events.click[0]()
  b.resolve({ outcome: 'confirmed', snapshot: snapshot('b', 'B', 'paused') }); await second
  assert.equal(f.button('b', '再開').disabled, false); assert.equal(f.button('a', '一時停止').disabled, true)
  a.resolve({ outcome: 'confirmed', snapshot: snapshot('a', 'A', 'paused') }); await first
  assert.equal(f.button('a', '再開').disabled, false); assert.equal(f.button('b', '再開').disabled, false)
})

test('a member changed after a list read started retains its newer result and the refresh button stays pending', async () => {
  const list = deferred(); let reads = 0
  const f = fixture(async (path, options) => {
    if (options?.method === 'POST') return { outcome: 'confirmed', snapshot: snapshot('b', 'B', 'paused') }
    return ++reads === 1 ? { goals: [snapshot('a', 'A'), snapshot('b', 'B')] } : list.promise
  }, ['a', 'b'])
  await f.view.open(); const refresh = f.view.refresh()
  await f.button('b', '一時停止').events.click[0]()
  assert.equal(f.refresh.disabled, true)
  list.resolve({ goals: [snapshot('a', 'A-new'), snapshot('b', 'B')] }); await refresh
  assert.equal(f.objective('a'), 'A-new'); assert.ok(f.button('b', '再開')); assert.equal(f.refresh.disabled, false)
})

test('a failed older list read removes stale rows but retains another member newer mutation', async () => {
  const list = deferred(); let reads = 0
  const f = fixture(async (_path, options) => options?.method === 'POST'
    ? { outcome: 'confirmed', snapshot: snapshot('b', 'B', 'paused') }
    : ++reads === 1 ? { goals: [snapshot('a', 'A'), snapshot('b', 'B')] } : list.promise, ['a', 'b'])
  await f.view.open(); const refresh = f.view.refresh(); await f.button('b', '一時停止').events.click[0]()
  list.reject(Error('artificial read failed')); await refresh
  assert.equal(f.row('a'), undefined); assert.ok(f.button('b', '再開')); assert.match(f.notice.textContent, /artificial read failed/)
})

test('a same-binding refresh before mutation completion is reconciled after commit without repeating the mutation', async () => {
  const held = deferred(); let current = snapshot('a', 'A'), writes = 0, readbacks = 0
  const f = fixture(async (path, options) => {
    if (options?.method === 'POST') { writes++; return held.promise }
    if (path === '/api/goals') return { goals: [current] }
    readbacks++; return { snapshot: current }
  })
  await f.view.open(); const changing = f.button('a', '一時停止').events.click[0]()
  await f.view.refresh(); assert.ok(f.button('a', '一時停止'))
  current = snapshot('a', 'A', 'paused'); held.resolve({ outcome: 'confirmed', snapshot: current }); await changing
  assert.equal(writes, 1); assert.equal(readbacks, 1); assert.equal(f.button('a', '再開').disabled, false)
})

test('a new thread refresh supersedes an in-flight post-completion readback', async () => {
  const held = deferred(), readback = deferred(), reading = deferred(); let current = snapshot('a', 'A')
  const f = fixture(async (path, options) => {
    if (options?.method === 'POST') return held.promise
    if (path === '/api/goals') return { goals: [current] }
    reading.resolve(); return readback.promise
  })
  await f.view.open(); const changing = f.button('a', '一時停止').events.click[0]()
  await f.view.refresh(); held.resolve({ outcome: 'confirmed', snapshot: snapshot('a', 'A', 'paused') }); await reading.promise
  current = snapshot('a', 'B'); await f.view.refresh(); readback.resolve({ snapshot: snapshot('a', 'A', 'paused') }); await changing
  assert.equal(f.objective('a'), 'B'); assert.equal(f.button('a', '再開'), undefined); assert.equal(f.button('a', '一時停止').disabled, false)
})

test('failed same-binding reconciliation removes stale controls and releases pending without a mutation retry', async () => {
  const held = deferred(); let writes = 0
  const f = fixture(async (path, options) => {
    if (options?.method === 'POST') { writes++; return held.promise }
    if (path === '/api/goals') return { goals: [snapshot('a', 'A')] }
    throw Error('artificial read failed')
  })
  await f.view.open(); const changing = f.button('a', '一時停止').events.click[0](); await f.view.refresh()
  held.resolve({ outcome: 'confirmed', snapshot: snapshot('a', 'A', 'paused') }); await changing
  assert.equal(writes, 1); assert.equal(f.button('a', '一時停止'), undefined); assert.match(f.notice.textContent, /確認できませんでした/)
  await f.view.refresh(); assert.equal(f.button('a', '一時停止').disabled, false)
})
