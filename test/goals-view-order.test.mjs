import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { goalsView } from '../web/goals.js'

const grokNative=JSON.parse(readFileSync(new URL('./fixtures/grok-goal-paused-native.json',import.meta.url)))

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

test('budget-only native editor omits the objective and sends one explicit budget mutation', async () => {
  const current = { ...snapshot('a', 'A'), fieldCapabilities: { edit: { objective: false, tokenBudget: true, combined: false } } }, writes = []
  const f = fixture(async (_path, options) => {
    if (!options) return { goals: [current] }
    writes.push(JSON.parse(options.body)); return { outcome: 'confirmed', snapshot: current }
  })
  await f.view.open(); f.button('a', '編集').events.click[0]()
  assert.equal(f.row('a').all().find(node => node.tagName === 'textarea'), undefined)
  const budget = f.row('a').all().find(node => node.tagName === 'input')
  budget.value = '42'; budget.events.input[0]()
  f.row('a').all().find(node => node.tagName === 'form').events.submit[0]({ preventDefault() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(writes, [{ action: 'edit', binding: current.binding, tokenBudget: 42 }])
})

test('separate native fields never become an automatic combined request', async () => {
  const current = { ...snapshot('a', 'A'), fieldCapabilities: { edit: { objective: true, tokenBudget: true, combined: false } } }, writes = []
  const f = fixture(async (_path, options) => {
    if (!options) return { goals: [current] }
    writes.push(JSON.parse(options.body)); return { outcome: 'confirmed', snapshot: current }
  })
  await f.view.open(); f.button('a', '編集').events.click[0]()
  let nodes = f.row('a').all()
  assert.equal(nodes.find(node => node.tagName === 'input'), undefined)
  const input = nodes.find(node => node.tagName === 'textarea'); input.value = '新目的'; input.events.input[0]()
  const choice = nodes.find(node => node.tagName === 'select'); choice.value = 'budget'; choice.events.change[0]()
  nodes = f.row('a').all(); assert.equal(nodes.find(node => node.tagName === 'textarea'), undefined)
  const budget = nodes.find(node => node.tagName === 'input'); budget.value = '7'; budget.events.input[0]()
  nodes.find(node => node.tagName === 'form').events.submit[0]({ preventDefault() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(writes, [{ action: 'edit', binding: current.binding, tokenBudget: 7 }])
})

test('same-binding field changes use the supported field while keeping the objective draft and binding', async () => {
  let current = { ...snapshot('a', 'A'), fieldCapabilities: { edit: { objective: true, tokenBudget: true, combined: false } } }
  const writes = []
  const f = fixture(async (_path, options) => {
    if (!options) return { goals: [current] }
    writes.push(JSON.parse(options.body)); return { outcome: 'confirmed', snapshot: current }
  })
  await f.view.open(); f.button('a', '編集').events.click[0]()
  let nodes = f.row('a').all()
  const input = nodes.find(node => node.tagName === 'textarea'); input.value = '保持する目的'; input.events.input[0]()
  const choice = nodes.find(node => node.tagName === 'select'); choice.value = 'budget'; choice.events.change[0]()
  current = { ...current, fieldCapabilities: { edit: { objective: true, tokenBudget: false, combined: false } } }
  await f.view.refresh(); nodes = f.row('a').all()
  assert.equal(nodes.find(node => node.tagName === 'select'), undefined)
  assert.equal(nodes.find(node => node.tagName === 'input'), undefined)
  assert.equal(nodes.find(node => node.tagName === 'textarea').value, '保持する目的')
  assert.equal(f.button('a', '保存').disabled, false)
  nodes.find(node => node.tagName === 'form').events.submit[0]({ preventDefault() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(writes, [{ action: 'edit', binding: current.binding, objective: '保持する目的' }])
})

test('Claude native goal shows only returned metrics and clear, then distinct cleared history', async () => {
  const active = { ...snapshot('a', 'A'), capabilities: { inspect: true, clear: true },
    goal: { kind: 'claude-code', phase: 'active', native: { type: 'goal_status', condition: 'Claude条件', met: false } } }
  const cleared = { ...active, goal: null, capabilities: { inspect: true }, nativeHistory: {
    kind: 'claude-code', terminal: 'cleared', native: { type: 'goal_status', condition: 'Claude条件', met: true, sentinel: true },
  } }
  let writes = 0
  const f = fixture(async (_path, options) => {
    if (!options) return { goals: [active] }
    writes++; assert.equal(JSON.parse(options.body).action, 'clear'); return { outcome: 'confirmed', snapshot: cleared }
  })
  await f.view.open(); assert.equal(f.objective('a'), 'Claude条件')
  for (const label of ['編集', '一時停止', '再開']) assert.equal(f.button('a', label), undefined)
  const text = f.row('a').all().map(node => node.textContent).join('\n')
  assert.match(text, /使用量・作業時間はまだ取得/); assert.doesNotMatch(text, /予算|0秒|一時停止したゴールは再開/)
  await f.button('a', '取り消す').events.click[0]()
  const after = f.row('a').all().map(node => node.textContent).join('\n')
  assert.match(after, /ゴールなし/); assert.match(after, /前のゴール：取消/); assert.doesNotMatch(after, /前のゴール：達成/)
  assert.equal(writes, 1)
})

test('Codex native wrapper keeps objective, accounting and paused resume control', async () => {
  const current = { ...snapshot('a', 'A'), goal: { kind: 'codex-cli', native: { objective: '元のCodex目的', status: 'paused', tokensUsed: 12, tokenBudget: 20, timeUsedSeconds: 3 } } }
  const f = fixture(async () => ({ goals: [current] }))
  await f.view.open(); assert.equal(f.objective('a'), '元のCodex目的'); assert.ok(f.button('a', '再開'))
  assert.match(f.row('a').all().map(node => node.textContent).join('\n'), /使用量 12 \/ 予算 20 · 作業時間 3秒/)
})

test('Grokはfresh current_statusの一時停止・使用量・時間を表示し、保存phaseと操作を補わない', async()=>{
  const goal=structuredClone(grokNative.goal)
  goal.native.status='active';goal.native.phase='Executing';goal.native.tokens_used_high_water=99999;goal.native.elapsed_ms=999999
  const current={...snapshot('a','A'),goal,capabilities:grokNative.capabilities}
  const f=fixture(async()=>({goals:[current]}));await f.view.open()
  const nodes=f.row('a').all(),text=nodes.map(n=>n.textContent).join('\n')
  assert.equal(nodes.find(n=>n.className==='goal-status').textContent,'一時停止')
  assert.equal(f.objective('a'),goal.native.objective)
  assert.match(text,/4,906/);assert.match(text,/14s/);assert.match(text,/待機/)
  assert.equal(text.includes('99,999'),false);assert.equal(text.includes('999999'),false)
  assert.equal(nodes.some(n=>n.tagName==='button'),false)
})
