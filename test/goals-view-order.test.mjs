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
function fixture(api, bots = ['a'], withChat = false) {
  globalThis.document = { createElement: tag => new Node(tag) }; globalThis.CSS = { escape: value => value }
  const dialog = new Node('dialog'), body = new Node('div'), notice = new Node('p'), refresh = new Node('button')
  dialog.parts = { '[data-goals-body]': body, '[data-goals-notice]': notice, '[data-goals-refresh]': refresh }
  const chat = new Node('details'), chatBody = new Node('div'), chatNotice = new Node('p'), chatRefresh = new Node('button'), summary = new Node('summary')
  chat.parts = { '[data-goals-body]': chatBody, '[data-goals-notice]': chatNotice, '[data-goals-refresh]': chatRefresh, '[data-goal-summary]': summary }
  const view = goalsView(dialog, api, () => bots.map(id => ({ id, name: id, harness: 'codex' })), withChat ? chat : null)
  const row = id => body.children.find(node => node.dataset.goalBot === id)
  const button = (id, text) => row(id)?.all().find(node => node.tagName === 'button' && node.textContent === text)
  const objective = id => row(id)?.all().find(node => node.className === 'goal-objective')?.textContent
  const chatRow = () => chatBody.children.find(node => node.dataset.goalBot)
  const chatButton = text => chatRow()?.all().find(node => node.tagName === 'button' && node.textContent === text)
  return { view, body, notice, refresh, row, button, objective, chat, chatBody, chatNotice, chatRefresh, summary, chatRow, chatButton }
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

test('Claude clear removes the configured list row and preserves distinct history in the chat', async () => {
  const active = { ...snapshot('a', 'A'), capabilities: { inspect: true, clear: true },
    goal: { kind: 'claude-code', phase: 'active', native: { type: 'goal_status', condition: 'Claude条件', met: false } } }
  const cleared = { ...active, goal: null, capabilities: { inspect: true }, nativeHistory: {
    kind: 'claude-code', terminal: 'cleared', native: { type: 'goal_status', condition: 'Claude条件', met: true, sentinel: true },
  } }
  let writes = 0, current = active
  const f = fixture(async (_path, options) => {
    if (!options) return _path === '/api/goals' ? { goals: [current] } : { snapshot: current }
    writes++; assert.equal(JSON.parse(options.body).action, 'clear'); current = cleared; return { outcome: 'confirmed', snapshot: cleared }
  }, ['a'], true)
  await f.view.select('a')
  await f.view.open(); assert.equal(f.objective('a'), 'Claude条件')
  for (const label of ['編集', '一時停止', '再開']) assert.equal(f.button('a', label), undefined)
  const text = f.row('a').all().map(node => node.textContent).join('\n')
  assert.match(text, /使用量・作業時間はまだ取得/); assert.doesNotMatch(text, /予算|0秒|一時停止したゴールは再開/)
  await f.button('a', '削除').events.click[0]()
  assert.equal(f.row('a'), undefined)
  const after = f.chatRow().all().map(node => node.textContent).join('\n')
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

test('Grok detailは原文表示を使い、null会計を保存数値で埋めず、phase表示nullも許す',async()=>{
  for(const paused of [false,true]){
    const native=JSON.parse(readFileSync(new URL('./fixtures/grok-goal-detail-native.json',import.meta.url)))
    const goal=native.goal;goal.native.phase='Idle';goal.native.tokens_used_high_water=99999
    if(paused){goal.current_status.status='Paused';goal.current_status.status_display='Paused';goal.current_status.phase_display=null}
    const current={...snapshot('a','A'),goal,capabilities:native.capabilities}
    const f=fixture(async()=>({goals:[current]}));await f.view.open()
    const nodes=f.row('a').all(),text=nodes.map(n=>n.textContent).join('\n')
    assert.equal(nodes.find(n=>n.className==='goal-status').textContent,goal.current_status.status_display)
    assert.equal(f.objective('a'),goal.native.objective)
    assert.match(text,/4\.9k \/ 1 tokens \(100%\)/);assert.match(text,/26s/)
    if(!paused)assert.match(text,/Planning/)
    assert.doesNotMatch(text,/4,906|99,999|待機|使用量 —|undefined|null/)
    assert.equal(nodes.some(n=>n.tagName==='button'),false)
  }
})

test('the dedicated list contains only confirmed configured goals and never calls unknown state empty', async () => {
  const active = snapshot('a', 'A')
  const f = fixture(async () => ({ goals: [active,
    { ...snapshot('b', 'B'), goal: null },
    { ...snapshot('c', 'C'), availability: 'unavailable' },
    { ...snapshot('d', 'D'), availability: 'unsupported' },
  ] }), ['a', 'b', 'c', 'd'])
  await f.view.open()
  assert.ok(f.row('a'))
  for (const id of ['b', 'c', 'd']) assert.equal(f.row(id), undefined)
  assert.doesNotMatch(f.body.all().map(node => node.textContent).join('\n'), /状態を取得できないメンバー/)
  const empty = fixture(async () => ({ goals: [{ botId: 'a', availability: 'unavailable' }] }))
  await empty.view.open()
  assert.match(empty.body.all().map(node => node.textContent).join('\n'), /表示できるゴールはありません/)
  assert.doesNotMatch(empty.body.all().map(node => node.textContent).join('\n'), /設定済みのゴールはありません/)
})

test('chat and list share pause, resume, objective edit and clear results with exactly one request per action', async () => {
  let current = snapshot('a', 'A'), writes = []
  current.goal.timeUsedSeconds = 14
  const f = fixture(async (path, options) => {
    if (!options) return path === '/api/goals' ? { goals: [current] } : { snapshot: current }
    const input = JSON.parse(options.body); writes.push(input)
    if (input.action === 'clear') current = { ...current, goal: null, capabilities: { create: true } }
    else current = { ...current, goal: { ...current.goal,
      status: input.action === 'pause' ? 'paused' : input.action === 'resume' ? 'active' : current.goal.status,
      ...(input.action === 'edit' ? { objective: input.objective } : {}),
    } }
    return { outcome: 'confirmed', snapshot: current }
  }, ['a'], true)
  await f.view.select('a'); await f.view.open()
  assert.match(f.summary.textContent, /目標に取り組み中.*14秒/)
  assert.equal(f.summary.textContent.includes('A'), false)
  await f.chatButton('一時停止').events.click[0]()
  assert.match(f.summary.textContent, /一時停止/); assert.ok(f.button('a', '再開'))
  await f.button('a', '再開').events.click[0]()
  assert.ok(f.chatButton('一時停止'))
  f.chatButton('編集').events.click[0]()
  const input = f.chatRow().all().find(node => node.tagName === 'textarea')
  input.value = '新しい目的'; input.events.input[0]()
  f.chatRow().all().find(node => node.tagName === 'form').events.submit[0]({ preventDefault() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.objective('a'), '新しい目的'); assert.equal(f.summary.title, '新しい目的')
  await f.button('a', '削除').events.click[0]()
  assert.equal(f.row('a'), undefined); assert.equal(f.summary.textContent, '目標未設定')
  assert.deepEqual(writes.map(input => input.action), ['pause', 'resume', 'edit', 'clear'])
  assert.ok(writes.every(input => input.binding.threadId === 'A'))
})

test('a late previous-chat read cannot display that member goal or controls in the current chat', async () => {
  const held = deferred()
  const f = fixture(async path => path.includes('/a/') ? held.promise : { snapshot: snapshot('b', 'B', 'paused') }, ['a', 'b'], true)
  const previous = f.view.select('a')
  await f.view.select('b')
  held.resolve({ snapshot: snapshot('a', 'A') }); await previous
  assert.equal(f.chatRow().dataset.goalBot, 'b'); assert.equal(f.summary.title, 'B')
  assert.ok(f.chatButton('再開')); assert.equal(f.chatButton('一時停止'), undefined)
  await f.view.select(null); assert.equal(f.chat.hidden, true)
})

test('chat read failure and omitted goal remain unknown without stale controls or zero elapsed time', async () => {
  let result = { snapshot: snapshot('a', 'A') }
  const f = fixture(async () => { if (result instanceof Error) throw result; return result }, ['a'], true)
  await f.view.select('a'); assert.ok(f.chatButton('一時停止'))
  assert.doesNotMatch(f.summary.textContent, /0秒/)
  result = Error('artificial read failure'); await f.view.refreshSelected()
  assert.match(f.summary.textContent, /状態を取得できません/)
  assert.equal(f.chatButton('一時停止'), undefined)
  result = { snapshot: { botId: 'a', availability: 'available' } }; await f.view.refreshSelected()
  assert.match(f.summary.textContent, /状態を取得できません/)
  assert.doesNotMatch(f.chatBody.all().map(node => node.textContent).join('\n'), /ゴールなし/)
})

test('chat Grok status uses the current observation and explains unavailable mutations', async () => {
  const original = structuredClone(grokNative.goal)
  original.native.status = 'active'; original.native.phase = 'Executing'
  const current = { ...snapshot('a', 'A'), goal: original, capabilities: grokNative.capabilities }
  const f = fixture(async () => ({ snapshot: current }), ['a'], true)
  await f.view.select('a')
  assert.match(f.summary.textContent, /一時停止.*14s/)
  assert.equal(f.chatButton('再開'), undefined)
  assert.match(f.chatBody.all().map(node => node.textContent).join('\n'), /編集・再開・削除を操作できません/)
})

test('list refresh releases chat update and message events do not pile reads onto an in-flight goal read', async () => {
  const held = deferred(); let reads = 0
  const current = snapshot('a', 'A')
  const f = fixture(async path => {
    if (path === '/api/goals') return { goals: [current] }
    return ++reads === 1 ? { snapshot: current } : held.promise
  }, ['a'], true)
  await f.view.select('a'); await f.view.refresh()
  assert.equal(f.chatRefresh.disabled, false)
  const reading = f.view.refreshSelected()
  f.view.refreshOnEvent(); f.view.refreshOnEvent()
  assert.equal(reads, 2); assert.equal(f.chatRefresh.disabled, true)
  held.resolve({ snapshot: current }); await reading
  assert.equal(f.chatRefresh.disabled, false)
})

test('reselecting during a mutation cannot apply a precommit read after confirmed or lost responses', async () => {
  for (const confirmed of [true, false]) {
    const post = deferred(), oldRead = deferred(); let reads = 0, writes = 0
    const active = snapshot('a', 'A'), paused = snapshot('a', 'A', 'paused')
    const f = fixture(async (_path, options) => {
      if (options?.method === 'POST') { writes++; return post.promise }
      reads++
      return reads === 1 ? { snapshot: active } : reads === 2 ? oldRead.promise : { snapshot: paused }
    }, ['a'], true)
    await f.view.select('a')
    const mutation = f.chatButton('一時停止').events.click[0]()
    await f.view.select(null)
    const reselected = f.view.select('a')
    if (confirmed) post.resolve({ outcome: 'confirmed', snapshot: paused })
    else post.reject(Error('artificial response lost'))
    await mutation
    oldRead.resolve({ snapshot: active }); await reselected
    assert.equal(f.chatButton('一時停止'), undefined)
    assert.match(f.summary.textContent, /状態を取得できません/)
    assert.equal(writes, 1)
    await f.view.refreshSelected()
    assert.ok(f.chatButton('再開')); assert.equal(f.chatRefresh.disabled, false)
  }
})
