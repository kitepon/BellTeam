import assert from 'node:assert/strict'
import test from 'node:test'
import { PendingByBot, SeatActivity, SeatTurnWatch } from '../src/seat-activity.mjs'
import { DeliveryJob } from '../src/delivery-job.mjs'

const bots = { a: { id: 'bot-a', name: 'A' }, b: { id: 'bot-b', name: 'B' } }
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail }); promise.catch(() => {}); return { promise, resolve, reject } }
const job = (id, bot, info = { context: 'direct', contextId: bot.id }) => new DeliveryJob({ id, bot, info, startedAt: `2026-10-23T00:00:0${id.at(-1)}.000Z` })
const tick = () => new Promise(resolve => setImmediate(resolve))

test('席ごとの進行中操作は、同じ操作が終わった時だけ外し、失敗を残す指定では失敗を次へ見せ続ける', async () => {
  const pending = new PendingByBot()
  const first = deferred(), second = deferred()
  pending.track('bot-a', first.promise)
  pending.track('bot-a', second.promise)
  first.resolve(); await tick()
  assert.equal(pending.get('bot-a'), second.promise)
  second.resolve(); await tick()
  assert.equal(pending.has('bot-a'), false)
  const failing = deferred()
  pending.track('bot-a', failing.promise, { clearOnFailure: false })
  failing.reject(new Error('synthetic')); await tick()
  assert.equal(pending.get('bot-a'), failing.promise)
})

test('受付前の配送jobは停止の対象だが「処理中」ではなく、受付後に処理中になり、終わると両方から消える', () => {
  const activity = new SeatActivity()
  const changes = []
  activity.watch(change => changes.push(change))
  const first = job('job-1', bots.a)
  activity.register(first)
  assert.equal(activity.hasJobs(bots.a.id), true)
  assert.equal(activity.idle(bots.a.id), true)
  assert.deepEqual(activity.stopTargets(), [first])
  assert.deepEqual(activity.items(), [])
  activity.admit(first)
  assert.equal(activity.idle(bots.a.id), false)
  assert.equal(activity.items({ botId: bots.a.id }).length, 1)
  assert.equal(activity.latest(bots.a.id), first)
  activity.release(first)
  assert.equal(activity.hasJobs(bots.a.id), false)
  assert.equal(activity.idle(bots.a.id), true)
  assert.deepEqual(changes.map(change => change.botIds), [[bots.a.id], [bots.a.id]])
})

test('ターンを追っている活動は最後に始まったものを選び、見張りは処理中に出るが停止の対象ではない', () => {
  const activity = new SeatActivity()
  const first = job('job-1', bots.a), second = job('job-2', bots.a), other = job('job-3', bots.b)
  for (const item of [first, second, other]) { activity.register(item); activity.admit(item) }
  first.follows = true
  assert.equal(activity.follower(bots.a.id), first)
  second.follows = true
  assert.equal(activity.follower(bots.a.id), second)
  assert.equal(activity.latest(bots.a.id), second)
  const watch = new SeatTurnWatch({ id: 'watch-1', bot: bots.b, turn: { turn_id: 't1', started_at: '2026-10-23T00:00:09.000Z' }, groupId: 'g1', now: 'now' })
  activity.beginWatch(watch)
  assert.equal(activity.follower(bots.b.id), watch)
  assert.equal(activity.followedTurns.get(bots.b.id), 't1')
  assert.equal(activity.shownWords.get(bots.b.id), watch.shown)
  assert.deepEqual(activity.items({ botId: bots.b.id }).map(item => item.context), ['direct', 'self'])
  assert.deepEqual(activity.stopTargets(), [first, second, other])
  watch.end()
  assert.equal(watch.stop.signal.aborted, true)
  activity.endWatch(watch)
  assert.equal(activity.watches.has(bots.b.id), false)
  assert.equal(activity.follower(bots.b.id), undefined)
  // 追い終えたターンは、見張りを外しても覚えておく（同じターンをもう一度追い始めない）。
  assert.equal(activity.followedTurns.get(bots.b.id), 't1')
})

test('空くのを待つのは、その席の処理中が全部終わるまでで、失敗した活動も待ちを壊さない', async () => {
  const activity = new SeatActivity()
  const first = job('job-1', bots.a), second = job('job-2', bots.a)
  const done = deferred(), failed = deferred()
  first.completion = done.promise; second.completion = failed.promise
  for (const item of [first, second]) { activity.register(item); activity.admit(item) }
  let idle = false
  const waiting = activity.whenIdle(bots.a.id).then(() => { idle = true })
  failed.reject(new Error('synthetic')); activity.release(second); await tick()
  assert.equal(idle, false)
  done.resolve(); activity.release(first)
  await waiting
  assert.equal(idle, true)
  assert.deepEqual(activity.items({ roomId: 'room-x' }), [])
})
