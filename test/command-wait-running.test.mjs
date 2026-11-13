import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { BotScheduler } from '../src/scheduler.mjs'
import { createExecutionFacade } from '../src/execution-facade.mjs'

// execution current-work.md 2026-11-12: a Bot waiting on its notify=result command reads running.
const bot = { id: 'bot-a', project: '/synthetic' }
const wait = { id: 's1', enabled: true, command: 'check-ci', notify: 'result' }

function registry(schedules) {
  const watchers = new Set()
  return { schedules, refresh: async () => {}, values: () => [bot], get: id => id === bot.id ? bot : null,
    listSchedules: async () => structuredClone(schedules.list), watch: listener => { watchers.add(listener); return () => watchers.delete(listener) },
    emit: change => { for (const listener of watchers) listener(change) } }
}

test('scheduler commandWait: enabled notify=result commands and running notify=result jobs only', async () => {
  const flips = []
  const schedules = { list: [{ ...wait, notify: undefined }, { id: 'p', enabled: true, prompt: 'x', notify: 'result' }, { ...wait, id: 's0', enabled: false }] }
  const reg = registry(schedules)
  const transport = { watchCurrentTurn: () => () => {}, currentTurn: () => ({ state: 'idle', turnId: null }) }
  const scheduler = new BotScheduler({ registry: reg, transport, intervalMs: 3_600_000, messenger: { sendmessage() {} }, onCommandWaitChange: id => flips.push(id) })
  await scheduler.runAfterTurn()
  assert.equal(scheduler.commandWait(bot.id), null, 'failure-notify, prompt and disabled schedules are not waits')
  scheduler.start()
  try {
    await scheduler.afterTurnRun; await scheduler.currentRun
    schedules.list.push(wait)
    reg.emit({ topics: ['schedules'], botIds: [bot.id] })
    await setImmediate(); await scheduler.afterTurnRun
    assert.match(scheduler.commandWait(bot.id), /^\d{4}-/)
    assert.deepEqual(flips, [bot.id])
    // An older list never overwrites a newer one.
    scheduler.noteWaits(bot.id, [], 0)
    assert.notEqual(scheduler.commandWait(bot.id), null)
    schedules.list = []
    reg.emit({ topics: ['schedules'], botIds: [bot.id] })
    await setImmediate(); await scheduler.afterTurnRun
    assert.equal(scheduler.commandWait(bot.id), null)
    assert.deepEqual(flips, [bot.id, bot.id])
  } finally { scheduler.stop() }
  // A consumed once schedule still waits while its command runs.
  const done = Promise.withResolvers()
  const running = new BotScheduler({ registry: reg, messenger: { sendmessage() {} }, runCommand: () => done.promise })
  const job = running.runCommandSchedule(bot, { ...wait, enabled: false })
  assert.notEqual(running.commandWait(bot.id), null)
  done.resolve({ code: 75, signal: null, stdout: '', stderr: '' })
  await job; await setImmediate()
  assert.equal(running.commandWait(bot.id), null)
})

test('facade: currentWork and runningState read working while waiting; currentTurn stays native', () => {
  let waiting = null
  const idle = { state: 'idle', summary: null, summaryStatus: 'missing', summaryUpdatedAt: null, observedAt: null, source: null }
  const controller = { dispatch() {}, close() {}, project: ({ method }) => method === 'transport.currentTurn' ? { state: 'idle', turnId: null } : idle }
  const { transport } = createExecutionFacade({ getController: () => controller, client: {}, membersAdmission: {}, requestStop() {},
    watchQueue: () => () => {}, commandWait: () => waiting })
  assert.deepEqual(transport.currentWork(bot), idle)
  assert.equal(transport.runningState(bot.id), 'idle')
  waiting = '2026-11-12T05:00:00.000Z'
  assert.deepEqual(transport.currentWork(bot), { ...idle, state: 'working', observedAt: waiting, reason: { kind: 'schedule', detail: null, since: waiting } })
  assert.equal(transport.runningState(bot.id), 'working')
  assert.deepEqual(transport.currentTurn(bot.id), { state: 'idle', turnId: null })
})
