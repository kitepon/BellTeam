import assert from 'node:assert/strict'
import test from 'node:test'

import { IdleSessions, pendingDecisionsByHarness, quietSession } from '../src/idle-sessions.mjs'

const MINUTE = 60_000
const quiet = (extra = {}) => ({
  exists: true, state: 'idle', reason: 'composer_ready', pending_child_deliveries: 0,
  activity: { cursor: 'c', output_changed: false, post_startup_process_count: 0 }, ...extra,
})

function setup(observations, { busy = false, pending = 0 } = {}) {
  const closed = []
  const cursors = []
  let time = 0
  const transport = {
    isIdle: () => !busy,
    async observeChain(bot, previous) { cursors.push(previous?.cursor); return { observation: observations.shift(), generation: null } },
    async closeIdle(bot) { if (busy) return false; closed.push(bot.id); return true },
  }
  const idle = new IdleSessions({
    bots: new Map([['bot-a', { id: 'bot-a' }]]), transport, pendingDecisions: async () => pending,
    idleMs: 30 * MINUTE, now: () => time, report: () => {},
  })
  return { idle, closed, cursors, advance: async minutes => { time += minutes * MINUTE; await idle.check() } }
}

test('入力待ちで、起動後のプロセスも子の配送待ちも無い席だけを「動いていない」とみなす', () => {
  assert.equal(quietSession(quiet()), true)
  assert.equal(quietSession(quiet({ state: 'busy', reason: 'turn_running' })), false)
  assert.equal(quietSession(quiet({ reason: 'approval_required' })), false)
  assert.equal(quietSession(quiet({ activity: { cursor: 'c', output_changed: false, post_startup_process_count: 1 } })), false)
  assert.equal(quietSession(quiet({ pending_child_deliveries: 1 })), false)
  assert.equal(quietSession(quiet({ pending_child_deliveries: null })), false)
  assert.equal(quietSession(quiet({ activity: { cursor: 'c', output_changed: false, post_startup_process_count: null } })), false)
  // 裏のプロセスの数を返さないAitermでは、閉じてよいか分からない。
  assert.equal(quietSession(quiet({ activity: { cursor: 'c', output_changed: false, background_cpu_seconds: 0 } })), false)
})

test('動きが無いまま30分を超えた席を閉じ、前回のcursorを渡して観測する', async () => {
  const { idle, closed, cursors, advance } = setup([
    quiet({ activity: { cursor: 'c1', output_changed: null, post_startup_process_count: 0 } }),
    quiet({ activity: { cursor: 'c2', output_changed: false, post_startup_process_count: 0 } }),
    quiet({ activity: { cursor: 'c3', output_changed: false, post_startup_process_count: 0 } }),
  ])
  await advance(0)
  await advance(25)
  assert.deepEqual(closed, [])
  await advance(5)
  assert.deepEqual(closed, ['bot-a'])
  assert.deepEqual(cursors, [undefined, 'c1', 'c2'])
  assert.equal(idle.seen.has('bot-a'), false)
})

test('観測の間に画面が変わった席と、動いている席は数え直す', async () => {
  const { closed, advance } = setup([
    quiet(),
    quiet({ activity: { cursor: 'c2', output_changed: true, post_startup_process_count: 0 } }),
    quiet({ state: 'busy', reason: 'turn_running' }),
    quiet(),
    quiet(),
  ])
  await advance(0)
  await advance(29)
  await advance(29)
  await advance(1)
  await advance(29)
  assert.deepEqual(closed, [])
})

test('BellTeamが配送中の席、裏の作業がある席、答え待ちの申請がある席、起きていない席は閉じない', async () => {
  const delivering = setup([quiet(), quiet()], { busy: true })
  await delivering.advance(0)
  await delivering.advance(40)
  assert.deepEqual(delivering.closed, [])

  const background = setup([
    quiet({ activity: { cursor: 'c', output_changed: false, post_startup_process_count: 2 } }),
    quiet({ activity: { cursor: 'c', output_changed: false, post_startup_process_count: 2 } }),
  ])
  await background.advance(0)
  await background.advance(40)
  assert.deepEqual(background.closed, [])

  for (const pending of [1, null]) {
    // 答え待ちの申請がある席と、申請の有無が分からない席。
    const waiting = setup([quiet(), quiet()], { pending })
    await waiting.advance(0)
    await waiting.advance(40)
    assert.deepEqual(waiting.closed, [])
  }

  const stopped = setup([{ exists: false }, { exists: false }])
  await stopped.advance(0)
  await stopped.advance(40)
  assert.deepEqual(stopped.closed, [])
})

test('観測に失敗した席は数え直し、ほかの席の観測を止めない', async () => {
  const closed = []
  let time = 0
  const transport = {
    isIdle: () => true,
    async observeChain(bot) { if (bot.id === 'bot-a') throw new Error('AITERM_DOWN'); return { observation: quiet(), generation: null } },
    async closeIdle(bot) { closed.push(bot.id); return true },
  }
  const reports = []
  const idle = new IdleSessions({
    bots: new Map([['bot-a', { id: 'bot-a' }], ['bot-b', { id: 'bot-b' }]]), transport, pendingDecisions: async () => 0,
    idleMs: 30 * MINUTE, now: () => time, report: message => reports.push(message),
  })
  await idle.check()
  time += 30 * MINUTE
  await idle.check()
  assert.deepEqual(closed, ['bot-b'])
  assert.match(reports[0], /bot-a を観測できませんでした（AITERM_DOWN）/u)
})

test('Approval Boxの答え待ちは、Claude Codeの席だけAitermの観測に任せ、ほかは分からないとして閉じない', () => {
  assert.equal(pendingDecisionsByHarness({ harness: 'claude' }), 0)
  for (const harness of ['codex', 'grok', 'cursor']) assert.equal(pendingDecisionsByHarness({ harness }), null)
})


test('module quiesce after the pending-decision await prevents an idle native close', async () => {
  let allowed = true, time = 0, finishDecision
  const closed = []
  const idle = new IdleSessions({ bots: new Map([['bot-a', { id: 'bot-a' }]]),
    transport: { observeChain: async () => ({ observation: quiet(), generation: null }), isIdle: () => true, closeIdle: async id => { closed.push(id); return true } },
    pendingDecisions: () => new Promise(resolve => { finishDecision = resolve }),
    allowClose: () => allowed, idleMs: 10, now: () => time,
  })
  await idle.check(); time = 11
  const pending = idle.check()
  while (!finishDecision) await new Promise(resolve => setImmediate(resolve))
  allowed = false; finishDecision(0); await pending
  assert.deepEqual(closed, [])
})

// a69: the harness's own unfinished background tasks (in-process agents) keep the seat open; absent/null = not stated.
test('a69: CLI自身が終わっていない裏の仕事を持つ席は「動いていない」とみなさない', () => {
  assert.equal(quietSession(quiet({ activity: { cursor: 'c', output_changed: false, post_startup_process_count: 0, background_tasks: 1 } })), false)
  assert.equal(quietSession(quiet({ activity: { cursor: 'c', output_changed: false, post_startup_process_count: 0, background_tasks: 0 } })), true)
  assert.equal(quietSession(quiet({ activity: { cursor: 'c', output_changed: false, post_startup_process_count: 0, background_tasks: null } })), true)
})
