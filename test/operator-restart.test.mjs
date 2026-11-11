import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AitermTransport } from '../src/aiterm-transport.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
async function fixture(t) {
  const project = await mkdtemp(join(tmpdir(), 'operator-restart-'))
  t.after(() => rm(project, { recursive: true, force: true }))
  const calls = []; let closeResolve, closeStarted
  const entered = new Promise(resolve => { closeStarted = resolve })
  const close = new Promise(resolve => { closeResolve = resolve })
  const transport = new AitermTransport({ handoffContext: async () => '', client: { async call(name, args) {
    calls.push({ name, args })
    if (name === 'pty_close') { closeStarted(); await close; return { structuredContent: { schema: 'aiterm.pty-close-result.v1', outcome: 'closed', session_id: args.session_id } } }
    if (name === 'agent_launch') return { structuredContent: { session_id: 'new-session' } }
    if (name === 'agent_configure') return {}
    throw new Error(`Unexpected ${name}`)
  } } })
  const bot = { id: 'bot-a', session: 'old-session', harness: 'codex', model: 'gpt-6.1-sol', project }
  return { bot, transport, calls, entered, closeResolve }
}

test('明示再起動は終わらない旧ターンを待たず閉じ、重複クリックと旧設定反映は新個体へ作用しない', async t => {
  const f = await fixture(t)
  let releaseOld
  const oldCompletion = new Promise(resolve => { releaseOld = resolve })
  f.transport.activity.active.set('old-job', { bot: f.bot, completion: oldCompletion })
  const obsolete = f.transport.reconfigure({ ...f.bot, harness: 'cursor' }, f.bot).catch(error => error)
  await tick()
  const first = f.transport.restart(f.bot)
  const duplicate = f.transport.restart(f.bot)
  await tick()
  assert.equal(f.calls.filter(c => c.name === 'pty_close').length, 1, 'restart must close before old completion')
  assert.equal(f.calls.some(c => c.name === 'agent_launch'), false, 'close must finish before launch')
  f.closeResolve()
  const results = await Promise.all([first, duplicate])
  assert.deepEqual(results, [{ botId: 'bot-a', session: 'new-session' }, { botId: 'bot-a', session: 'new-session' }])
  f.transport.activity.active.clear(); releaseOld()
  assert.equal((await obsolete).code, 'BOT_STOPPED')
  assert.deepEqual(f.calls.map(c => c.name), ['pty_close', 'agent_launch'])
  assert.equal(f.calls[1].args.harness, 'codex-cli')
})

test('an unknown close result is recorded and does not block the operator launch', async t => {
  const f = await fixture(t)
  f.transport.client.call = async (name, args) => {
    f.calls.push({ name, args })
    if (name === 'pty_close') throw Error('RPC_CLOSED_WITHOUT_RECEIPT')
    return { structuredContent: { session_id: 'new-session' } }
  }
  await f.transport.restart(f.bot)
  assert.deepEqual(f.calls.map(c => c.name), ['pty_close', 'agent_launch'])
})

test('a close Aiterm answered as failed launches nothing and returns the reason', async t => {
  const f = await fixture(t)
  f.transport.client.call = async (name, args) => {
    f.calls.push({ name, args })
    if (name === 'pty_close') throw Object.assign(Error('aiterm: remote close failed\nremote=macbook'), { aitermResponseReturned: true })
    return { structuredContent: { session_id: 'new-session' } }
  }
  await assert.rejects(f.transport.restart(f.bot), { code: 'RESTART_CLOSE_FAILED', effect: 'not_started', reason: 'aiterm: remote close failed' })
  assert.deepEqual(f.calls.map(c => c.name), ['pty_close'])
})

test('旧配送をclose後に終了させ、再起動中の新配送は新個体へ一回だけ送る', async t => {
  const f = await fixture(t)
  let startWait; const waiting = new Promise(resolve => { startWait = resolve })
  let waitCount = 0
  f.transport.waitProcess = async (_process, signal) => {
    if (++waitCount === 1) { startWait(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })) }
    return { outcome: 'done' }
  }
  const original = f.transport.client.call
  f.transport.client.call = async (name, args) => {
    if (name === 'pty_send') { f.calls.push({ name, args }); return { structuredContent: { mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: '/synthetic/wait', args: [] } } } }
    if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: 'new reply' } }
    return original(name, args)
  }
  const old = f.transport.turn(f.bot, 'old already accepted')
  const oldResult = old.catch(error => error)
  await old.accepted; await waiting
  const restart = f.transport.restart(f.bot)
  const next = f.transport.turn(f.bot, 'new owner request')
  await tick()
  assert.equal(f.calls.filter(c => c.name === 'pty_send').length, 1)
  f.closeResolve(); await restart
  assert.equal((await oldResult).code, 'BOT_STOPPED')
  assert.equal(await next, 'new reply')
  assert.deepEqual(f.calls.filter(c => c.name === 'pty_send').map(c => [c.args.session_id, c.args.text]), [['old-session', 'old already accepted'], ['new-session', 'new owner request']])
  assert.equal(f.transport.activity.active.size, 0)
})

test('発行済み旧起動の返却を待ってその個体を閉じ、後着旧起動と新起動を重ねない', async t => {
  const f = await fixture(t)
  let finishWake
  const waking = new Promise(resolve => { finishWake = resolve })
  f.transport.activity.waking.track(f.bot.id, waking)
  const pending = f.transport.restart(f.bot)
  await tick(); assert.deepEqual(f.calls, [])
  f.transport.sessions.set(f.bot.id, 'late-old-session'); finishWake()
  await f.entered
  assert.deepEqual(f.calls.map(c => [c.name, c.args.session_id]), [['pty_close', 'late-old-session']])
  f.closeResolve(); await pending
  assert.deepEqual(f.calls.map(c => c.name), ['pty_close', 'agent_launch'])
})

test('member DELETE closes a turn that never ends (first-run screen) and ends its delivery, like restart (lab 2026-11-12)', async t => {
  const f = await fixture(t)
  let startWait; const waiting = new Promise(resolve => { startWait = resolve })
  f.transport.waitProcess = async (_process, signal) => {
    startWait(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    return { outcome: 'done' }
  }
  const original = f.transport.client.call
  f.transport.client.call = async (name, args) => {
    if (name === 'pty_send') { f.calls.push({ name, args }); return { structuredContent: { mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: '/synthetic/wait', args: [] } } } }
    if (name === 'pty_list') return { structuredContent: { sessions: [] } }
    return original(name, args)
  }
  const stuck = f.transport.turn(f.bot, 'turn at the first-run screen').catch(error => error)
  await stuck.accepted; await waiting
  const deleting = f.transport.stop(f.bot, undefined, { allSessions: true })
  await f.entered
  f.closeResolve(); await deleting
  await stuck
  await f.transport.idle(f.bot.id)
  assert.equal(f.transport.isIdle(f.bot.id), true)
  assert.deepEqual(f.calls.map(c => c.name), ['pty_send', 'pty_close'])
})
