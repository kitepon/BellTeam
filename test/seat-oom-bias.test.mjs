import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { OOM_BIAS_SCRIPT, SeatOomBias, IDLE_ADJ, WORKING_ADJ } from '../src/seat-oom-bias.mjs'
import { SeatActivity } from '../src/seat-activity.mjs'

const adj = pid => readFileSync(`/proc/${pid}/oom_score_adj`, 'utf8').trim()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (check, what) => { for (let i = 0; i < 100; i++) { const value = check(); if (value) return value; await sleep(50) } throw new Error(what) }

test('the script lowers a seat tree by session and leaves other processes and other values alone', { skip: process.platform !== 'linux' }, async t => {
  const session = `bot-test-1st-${process.pid}x`
  const kids = []
  const start = args => { const child = spawn(args[0], args.slice(1), { stdio: ['pipe', 'ignore', 'ignore'] }); kids.push(child); t.after(() => child.kill()); return child }
  // seat leader: names the session as a whole argument; its child (no session in its command line) inherits 1000
  const leader = start(['/bin/sh', '-c', 'echo 1000 > /proc/self/oom_score_adj; sleep 60 & wait', 'sh', session])
  const stream = start(['/bin/sh', '-c', 'echo 1000 > /proc/self/oom_score_adj; read x', 'sh', `/x/agents/${session}.launch.claude-stream.jsonl`])
  const bodySide = start(['/bin/sh', '-c', 'echo 0 > /proc/self/oom_score_adj; read x', 'sh', session])
  const other = start(['/bin/sh', '-c', 'echo 1000 > /proc/self/oom_score_adj; read x', 'sh', `${session}-fork-1`])
  const grandchild = await until(() => { try { return Number(readFileSync(`/proc/${leader.pid}/task/${leader.pid}/children`, 'utf8').trim().split(' ')[0]) || null } catch { return null } }, 'no child')
  await until(() => [leader, stream, other].every(child => adj(child.pid) === '1000') && adj(grandchild) === '1000', 'adj not set')
  const run = value => promisify(execFile)(process.execPath, ['-e', OOM_BIAS_SCRIPT, session, value])
  assert.ok(JSON.parse((await run('500')).stdout).set >= 3)
  assert.deepEqual([leader.pid, grandchild, stream.pid].map(adj), ['500', '500', '500'])
  assert.equal(adj(bodySide.pid), '0', 'a value this feature does not own is never rewritten')
  assert.equal(adj(other.pid), '1000', 'another session (a fork) is not the seat')
  await run('1000')
  assert.deepEqual([leader.pid, grandchild, stream.pid].map(adj), ['1000', '1000', '1000'])
  assert.equal(JSON.parse((await promisify(execFile)(process.execPath, ['-e', OOM_BIAS_SCRIPT, session, '0'])).stdout).set, 0, 'only 500/1000 are accepted')
})

const harness = ({ refreshMs = 60_000 } = {}) => {
  const activity = new SeatActivity(), calls = [], clock = { now: 0 }, bot = { id: 'bot-a' }
  const job = { id: 'j1', bot, info: {}, completion: Promise.resolve() }
  const state = { fail: false }
  const bias = new SeatOomBias({ activity, bots: new Map([[bot.id, bot]]), session: item => `s-${item.id}`, now: () => clock.now, refreshMs,
    run: async ({ args }) => { calls.push(args.slice(2).join(' ')); if (state.fail) throw Object.assign(new Error('x'), { code: 'SEAT_PROCESS_FAILED' }) } })
  return { activity, calls, clock, job, state, stop: bias.start() }
}
const settle = () => sleep(5)

test('a seat goes to 500 when its turn starts and back to 1000 when it ends; repeated changes do nothing', async () => {
  const { activity, calls, job } = harness()
  activity.admit(job); activity.emit(job); await settle()
  assert.deepEqual(calls, [`s-bot-a ${WORKING_ADJ}`])
  activity.release(job); await settle()
  assert.deepEqual(calls, [`s-bot-a ${WORKING_ADJ}`, `s-bot-a ${IDLE_ADJ}`])
  activity.emit(job); await settle()
  assert.equal(calls.length, 2, 'a quiet seat that is already 1000 is not touched')
})

test('a working seat is lowered again at most once per refresh window (a relaunched seat starts at 1000)', async () => {
  const { activity, calls, clock, job } = harness()
  activity.admit(job); await settle()
  clock.now = 30_000; activity.emit(job); await settle()
  assert.equal(calls.length, 1)
  clock.now = 61_000; activity.emit(job); await settle()
  assert.equal(calls.length, 2)
})

test('a failed write is retried at the next activity change and never throws', async () => {
  const { activity, calls, state, job } = harness()
  state.fail = true
  activity.admit(job); await settle()
  assert.equal(calls.length, 1)
  state.fail = false
  activity.emit(job); await settle()
  assert.deepEqual(calls, [`s-bot-a ${WORKING_ADJ}`, `s-bot-a ${WORKING_ADJ}`])
})
