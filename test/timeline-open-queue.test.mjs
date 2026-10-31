import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')
const functions = source.slice(source.indexOf('async function openTimeline()'), source.indexOf('async function refreshTimeline()'))
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const settle = () => new Promise(resolve => setImmediate(resolve))
function fixture() {
  const queues = [], rendered = [], state = { timelineToken: 0, timelineQueueRequest: 0 }
  let selected = 'a'
  const context = vm.createContext({ state, latestButton: {}, timelineTail: { replaceChildren() {} },
    messagesPath: () => selected + '/messages', queuePath: () => selected + '/queue', TIMELINE_FIRST_PAGE: 10,
    api: async path => {
      if (path.endsWith('/queue')) { const pending = deferred(); queues.push(pending); return pending.promise }
      return { items: [{ id: selected + '-message' }], has_more: false }
    },
    timelineItems: { replaceChildren(...rows) { rendered.splice(0, rendered.length, ...rows) } },
    normalizeItems: items => items, rememberItems: items => items.forEach(item => state.timelineMap.set(item.id, item)),
    dayLabel: () => 'day', renderItem: item => item.id, queuedFor: () => [], renderTail() {}, rerenderItem() {}, scrollToBottom() {}, loadStoredMessageImages() {},
  })
  vm.runInContext(functions, context)
  return { queues, rendered, state, open: () => context.openTimeline(), select: id => { selected = id } }
}
test('新規会話の本文はqueue応答を待たず表示し、前の会話の遅いqueueは混ざらない', async () => {
  const f = fixture()
  await f.open(); assert.deepEqual(f.rendered, ['day', 'a-message'])
  f.select('b'); await f.open(); assert.deepEqual(f.rendered, ['day', 'b-message'])
  f.queues[1].resolve({ items: [{ id: 'b-queue' }] }); await settle()
  f.queues[0].resolve({ items: [{ id: 'a-queue' }] }); await settle()
  assert.equal(f.state.timelineQueue[0].id, 'b-queue')
})
test('queue取得の失敗は本文を消さず、状態不明を別表示する', async () => {
  const f = fixture()
  await f.open(); f.queues[0].reject(new Error('unavailable')); await settle()
  assert.deepEqual(f.rendered, ['day', 'a-message'])
  assert.match(f.state.timelineQueueError, /取得できません/)
})
