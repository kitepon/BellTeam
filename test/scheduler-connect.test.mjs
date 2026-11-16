import assert from 'node:assert/strict'
import test from 'node:test'
import { BotScheduler } from '../src/scheduler.mjs'

const bot = { id: 'bot-owner', project: '/synthetic' }
const connect = { project: 'bellteam', plan: 'p1', task: 't1' }
const schedule = { id: 's-1', name: 'ci check', kind: 'interval_hours', command: 'synthetic', connect, enabled: true, revision: 3,
  intervalHours: 1, startHour: 0, endHour: 23, minute: 0, lastRunAt: null, nextRunAt: '2026-11-15T00:00:00.000Z' }

// facade answers: show -> the lane; resolve/remove -> `answer`.
function harness({ outcome, answer = { exitCode: 0, result: { unchanged: false } }, lane = 'bot-lane', lattice = true, stored = schedule }) {
  const sent = [], calls = [], saved = []
  const facade = { run: async input => {
    calls.push(input)
    if (input.args[1] === 'show') return { exitCode: 0, result: { task: { lane } } }
    if (answer instanceof Error) throw answer
    return answer
  } }
  const registry = { get: id => id === 'bot-lane' || id === bot.id ? { id } : undefined,
    listSchedules: async () => [stored], setSchedule: async (id, input) => { saved.push([id, input]) } }
  const scheduler = new BotScheduler({ registry, messenger: { sendmessage(input) { sent.push(input) } },
    runCommand: async () => outcome, lattice: () => lattice ? facade : null })
  return { scheduler, sent, calls, saved }
}
const done = { code: 0, signal: null, stdout: 'a\nb\nc\nd\ne\nf', stderr: '' }

test('exit 0 resolves the connection, disables the schedule and sends no message', async () => {
  const { scheduler, sent, calls, saved } = harness({ outcome: done })
  await scheduler.runCommandSchedule(bot, schedule)
  assert.deepEqual(calls, [{ from: bot.id, projectId: 'bellteam', args: ['todo', 'connect', 'condition', 'resolve', '--plan', 'p1', '--task', 't1', '--to', 'schedule:s-1', '--message', 'b\nc\nd\ne\nf'] }])
  assert.deepEqual(sent, [])
  assert.equal(saved.length, 1)
  assert.equal(saved[0][1].enabled, false)
  assert.equal(saved[0][1].id, 's-1')
  assert.equal(Object.hasOwn(saved[0][1], 'nextRunAt'), false)
})

test('an edited schedule (newer revision) or an already disabled one is not disabled again', async () => {
  for (const stored of [{ ...schedule, revision: 4 }, { ...schedule, enabled: false }]) {
    const { scheduler, saved } = harness({ outcome: done, stored })
    await scheduler.runCommandSchedule(bot, schedule)
    assert.deepEqual(saved, [])
  }
})

test('exit 75 touches nothing', async () => {
  const { scheduler, sent, calls, saved } = harness({ outcome: { code: 75, signal: null, stdout: 'not yet', stderr: '' } })
  await scheduler.runCommandSchedule(bot, schedule)
  assert.deepEqual([calls, sent, saved], [[], [], []])
})

test('exit 75 on a once schedule is a failure: it is never checked again', async () => {
  const once = { ...schedule, kind: 'once', enabled: false }
  const { scheduler, sent } = harness({ outcome: { code: 75, signal: null, stdout: 'not yet', stderr: '' }, stored: once })
  await scheduler.runCommandSchedule(bot, once)
  assert.deepEqual(sent.map(({ target }) => target), ['bot-lane'])
})

test('failure notifies the lane Bot only, keeps the connection and disables the schedule', async () => {
  for (const outcome of [{ code: 1, signal: null, stdout: '', stderr: 'gh failed' }, { code: null, signal: 'SIGKILL', stdout: '', stderr: '' }]) {
    const { scheduler, sent, calls, saved } = harness({ outcome })
    await scheduler.runCommandSchedule(bot, schedule)
    assert.deepEqual(calls.map(call => call.args.slice(0, 2)), [['todo', 'show']])
    assert.deepEqual(sent.map(({ from, target }) => ({ from, target })), [{ from: 'scheduler', target: 'bot-lane' }])
    assert.ok(sent[0].message.includes('[BellTeam schedule s-1]') && sent[0].message.includes('p1/t1') && sent[0].message.includes('接続'))
    assert.equal(saved.length, 1)
  }
})

test('a lane that is not a Bot falls back to the schedule owner', async () => {
  for (const lane of ['owner', null]) {
    const { scheduler, sent } = harness({ outcome: { code: 2, signal: null, stdout: '', stderr: 'x' }, lane })
    await scheduler.runCommandSchedule(bot, schedule)
    assert.deepEqual(sent.map(input => input.target), [bot.id])
  }
})

test('a resolve that is pending, unsent, thrown or without a facade gives one lane notice and disables', async () => {
  for (const [answer, lattice] of [
    [{ exitCode: null, result: { code: 'LATTICE_WRITE_PENDING' } }, true],
    [{ exitCode: 1, result: { code: 'CONNECTION_INVALID' } }, true],
    [undefined, false],
  ]) {
    const { scheduler, sent, saved } = harness({ outcome: done, answer, lattice })
    await scheduler.runCommandSchedule(bot, schedule)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].target, lattice ? 'bot-lane' : bot.id)
    assert.ok(sent[0].message.includes('接続の完了を記録できなかった'))
    assert.equal(saved.length, 1)
  }
})

test('an unconnected schedule keeps the existing contract (owner and user, no facade, no disable)', async () => {
  const { connect: _, ...plain } = schedule
  const { scheduler, sent, calls, saved } = harness({ outcome: { code: 1, signal: null, stdout: '', stderr: 'bad' } })
  await scheduler.runCommandSchedule(bot, plain)
  assert.deepEqual(sent.map(({ from, target }) => ({ from, target })), [{ from: 'scheduler', target: bot.id }, { from: bot.id, target: 'user' }])
  assert.deepEqual([calls, saved], [[], []])
})

test('releaseConnection removes the connection as the owner Bot and notifies the lane once if that fails', async () => {
  const ok = harness({ outcome: done })
  await ok.scheduler.releaseConnection(bot.id, schedule)
  assert.deepEqual(ok.calls, [{ from: bot.id, projectId: 'bellteam', args: ['todo', 'connect', 'condition', 'remove', '--plan', 'p1', '--task', 't1', '--to', 'schedule:s-1', '--reason', 'schedule removed'] }])
  assert.deepEqual(ok.sent, [])
  const failed = harness({ outcome: done, answer: { exitCode: 1, result: { code: 'LATTICE_INVALID' } } })
  await failed.scheduler.releaseConnection(bot.id, schedule)
  assert.deepEqual(failed.sent.map(input => input.target), ['bot-lane'])
})
