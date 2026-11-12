import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { BotScheduler } from '../src/scheduler.mjs'

const bot = { id: 'bot-owner', project: '/synthetic' }
const schedule = { id: 'failure-1', name: 'check', command: 'synthetic' }

test('nonzero, signal and runner exception each notify the schedule owner and user once', async () => {
  for (const outcome of [
    { code: 7, signal: null, stdout: '', stderr: 'one\ntwo\nthree\nfour\nfive\nsix' },
    { code: null, signal: 'SIGTERM', stdout: 'signal failure', stderr: '' },
    new Error('runner failed'),
  ]) {
    const sent = []
    let runs = 0
    const scheduler = new BotScheduler({ registry: {}, messenger: { sendmessage(input) { sent.push(input) } },
      runCommand: async () => { runs++; if (outcome instanceof Error) throw outcome; return outcome } })
    const result = await scheduler.runCommandSchedule(bot, schedule)
    assert.equal(runs, 1)
    assert.equal(scheduler.commandJobs.size, 0)
    assert.deepEqual(sent.map(({ from, target }) => ({ from, target })), [
      { from: 'scheduler', target: bot.id }, { from: bot.id, target: 'user' },
    ])
    assert.equal(sent[0].message, sent[1].message)
    assert.ok(sent[0].message.includes('[BellTeam schedule failure-1]'))
    if (outcome instanceof Error) assert.equal(result.stderr, outcome.message)
    else assert.equal(result, outcome)
    if (result.code === 7) assert.ok(sent[0].message.endsWith('two\nthree\nfour\nfive\nsix'))
    else assert.ok(sent[0].message.endsWith(result.stderr || result.stdout))
  }
})

test('either notification may fail without blocking the other, and both outcomes are awaited', async () => {
  for (const failedTargets of [[bot.id], ['user'], [bot.id, 'user']]) {
    const calls = [], pending = Promise.withResolvers()
    const errors = Object.fromEntries(failedTargets.map(target => [target, new Error(target)]))
    const result = Object.freeze({ code: 1, signal: null, stdout: '', stderr: 'retained incident reference' })
    const scheduler = new BotScheduler({ registry: {}, runCommand: async () => result,
      messenger: { sendmessage(input) {
        calls.push(input)
        if (input.target === bot.id) { if (errors[bot.id]) throw errors[bot.id]; return { delivery: 'running' } }
        return pending.promise
      } } })
    let settled = false
    const operation = scheduler.runCommandSchedule(bot, schedule)
    operation.then(() => { settled = true }, () => { settled = true })
    await setImmediate()
    assert.deepEqual(calls.map(input => input.target), [bot.id, 'user'])
    assert.equal(settled, false)
    assert.equal(scheduler.commandJobs.size, 1)
    if (errors.user) pending.reject(errors.user)
    else pending.resolve({ delivery: 'delivered' })
    await assert.rejects(operation, error => failedTargets.length === 1 ? error === errors[failedTargets[0]]
      : error instanceof AggregateError && error.errors[0] === errors[bot.id] && error.errors[1] === errors.user)
    assert.equal(scheduler.commandJobs.size, 0)
    assert.equal(result.code, 1)
    assert.equal(calls.length, 2)
  }
})

test('healthy and interrupted commands produce no owner or user notification', async () => {
  const sent = [], done = Promise.withResolvers()
  const scheduler = new BotScheduler({ registry: {}, messenger: { sendmessage(input) { sent.push(input) } },
    runCommand: async () => ({ code: 0, signal: null, stdout: 'healthy', stderr: '' }) })
  await scheduler.runCommandSchedule(bot, schedule)
  scheduler.runCommand = () => done.promise
  const operation = scheduler.runCommandSchedule(bot, schedule)
  const [job] = scheduler.commandJobs
  job.controller.abort()
  const result = { code: null, signal: 'SIGTERM', stdout: '', stderr: '', stopConfirmed: true }
  done.resolve(result)
  assert.equal(await operation, result)
  assert.deepEqual(sent, [])
})

test('notify=result delivers exit 0 to the owner Bot only, stays quiet on 75 and keeps the failure contract', async () => {
  const resultSchedule = { ...schedule, notify: 'result' }
  for (const [outcome, targets] of [
    [{ code: 0, signal: null, stdout: 'a\nb\nc\nd\ne\nnpm has 0.89.0', stderr: 'noise' }, [bot.id]],
    [{ code: 75, signal: null, stdout: 'pending', stderr: '' }, []],
    [{ code: 1, signal: null, stdout: '', stderr: 'gh failed' }, [bot.id, 'user']],
  ]) {
    const sent = []
    const scheduler = new BotScheduler({ registry: {}, messenger: { sendmessage(input) { sent.push(input) } }, runCommand: async () => outcome })
    assert.equal(await scheduler.runCommandSchedule(bot, resultSchedule), outcome)
    assert.deepEqual(sent.map(input => input.target), targets)
    if (outcome.code === 0) {
      assert.equal(sent[0].from, 'scheduler')
      assert.ok(sent[0].message.includes('終了コード0'))
      assert.ok(sent[0].message.endsWith('b\nc\nd\ne\nnpm has 0.89.0'))
    }
  }
})

test('notify is command-only, stored only as result, and kept by updates that omit it', async () => {
  const { normalizeSchedule } = await import('../src/schedule-definition.mjs')
  const now = new Date('2026-11-12T00:00:00Z')
  const once = { id: 's', kind: 'once', at: '2026-11-12T01:00:00Z', command: 'true' }
  assert.equal(normalizeSchedule({ ...once, notify: 'result' }, now).notify, 'result')
  assert.equal(Object.hasOwn(normalizeSchedule({ ...once, notify: 'failure' }, now), 'notify'), false)
  for (const bad of [{ ...once, notify: 'always' }, { id: 's', kind: 'once', at: once.at, prompt: 'p', notify: 'result' }])
    assert.throws(() => normalizeSchedule(bad, now), /SCHEDULE_NOTIFY_INVALID/)
  const { validateMembersResult } = await import('../src/members/protocol.mjs')
  validateMembersResult('schedules.set', { schedule: { ...normalizeSchedule({ ...once, notify: 'result' }, now), revision: 1 } })
})
