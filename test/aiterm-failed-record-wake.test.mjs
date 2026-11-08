import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AitermClient, AitermTransport } from '../src/aiterm-transport.mjs'

// Aiterm 0.63.xは復帰に失敗した席を一覧と観測に残す（exists=true, state=unknown, reason=agent_failed）。
const observation = (reason, state = reason === 'agent_failed' ? 'unknown' : 'idle') => ({ schema: 'aiterm.pty-observe-result.v1',
  session_id: 'bot-a', exists: true, harness: 'codex-cli', launch_id: 'a'.repeat(32), state, reason })

// 起こした直後の席がAitermの入力受付確認（30秒）に通らなかった時の断り。本文は送られていない。
const notReady = "aiterm: AGENT_INPUT_NOT_READY: agent session 'bot-a' の Codex TUI が入力受付状態になりません。文字列は送信していません。少し後で pty_read(screen:true) を確認し、TUI が起動済みなら再度 pty_send してください。\nstate=idle reason=composer_ready"

function seatClient(reason, state, { notReadySends = 0, firstError = null, observed = null } = {}) {
  const calls = []
  const classifier = new AitermClient()
  const client = { call: (name, args) => classifier.call(name, args) }
  classifier.client = { async callTool({ name, arguments: args }) {
    calls.push([name, args])
    if (name === 'pty_send' && firstError && calls.filter(([tool]) => tool === 'pty_send').length === 1)
      return { isError: true, content: [{ type: 'text', text: firstError }] }
    if (name === 'pty_observe' && observed) return { structuredContent: observed }
    if (name === 'pty_send' && reason === 'agent_failed' && state !== 'busy' && !calls.some(([tool]) => tool === 'agent_launch'))
      return { isError: true, content: [{ type: 'text', text: notReady }] }
    if (name === 'pty_send' && calls.slice(calls.findIndex(([tool]) => tool === 'agent_launch') + 1).filter(([tool]) => tool === 'pty_send').length <= notReadySends)
      return { isError: true, content: [{ type: 'text', text: notReady }] }
    if (name === 'pty_observe') return { structuredContent: observation(reason, state) }
    if (name === 'pty_list') return { content: [{ type: 'text', text: 'bot-a\tcodex' }] }
    if (name === 'agent_configure') return { structuredContent: { schema: 'aiterm.agent-configure-result.v1', session_id: 'bot-a' } }
    if (name === 'pty_close') return { content: [{ type: 'text', text: 'closed' }] }
    if (name === 'agent_launch') return { structuredContent: { session_id: 'bot-a' } }
    if (name === 'pty_send') return { structuredContent: {
      mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: '/node', args: ['wait'] },
    } }
    if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: '了解' } }
    throw new Error(`unexpected tool: ${name}`)
  } }
  return { client, calls }
}

test('復帰に失敗した記録の席は、設定を当てずに記録ごと閉じて起こし直し、同じ文を1回だけ送る', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-failed-record-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { client, calls } = seatClient('agent_failed')
  const transport = new AitermTransport({ client, handoffContext: async () => '', waitProcess: async () => ({ outcome: 'done' }) })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'codex', project: root }
  const written = []
  t.mock.method(process.stderr, 'write', text => { written.push(String(text)); return true })

  await transport.turn(bot, '再現用の本文')

  assert.deepEqual(calls.map(([name]) => name), ['pty_send', 'pty_observe', 'pty_close', 'agent_launch', 'pty_send', 'pty_read'])
  assert.deepEqual(calls[2][1], { session_id: 'bot-a' })
  assert.deepEqual(calls.filter(([name]) => name === 'pty_send').map(([, args]) => args),
    Array(2).fill({ session_id: 'bot-a', text: '再現用の本文', require_agent: true }))
  assert.equal(written.filter(text => text.includes('agent registration unavailable')).length, 1)
})

for (const [label, reason, state] of [['休止して再開待ちの席', 'idle_timeout'], ['失敗記録でも動くターンが観測される席', 'agent_failed', 'busy']]) test(`${label}は閉じず、従来どおりそのまま送る`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-failed-record-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { client, calls } = seatClient(reason, state)
  const transport = new AitermTransport({ client, handoffContext: async () => '', waitProcess: async () => ({ outcome: 'done' }) })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'codex', project: root }

  await transport.turn(bot, '再現用の本文')

  assert.equal(calls.some(([name]) => ['pty_close', 'agent_launch'].includes(name)), false)
  assert.deepEqual(calls.filter(([name]) => name === 'pty_send').length, 1)
})

test('起こした直後の席が入力受付の確認に通らなかった時は、同じ文を送り直す', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-failed-record-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { client, calls } = seatClient('agent_failed', undefined, { notReadySends: 2 })
  const transport = new AitermTransport({ client, handoffContext: async () => '', waitProcess: async () => ({ outcome: 'done' }) })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'codex', project: root }
  const written = []
  t.mock.method(process.stderr, 'write', text => { written.push(String(text)); return true })

  await transport.turn(bot, '再現用の本文')

  assert.deepEqual(calls.map(([name]) => name), ['pty_send', 'pty_observe', 'pty_close', 'agent_launch', 'pty_send', 'pty_send', 'pty_send', 'pty_read'])
  assert.equal(new Set(calls.filter(([name]) => name === 'pty_send').map(([, args]) => JSON.stringify(args))).size, 1)
  assert.equal(written.filter(text => text.includes('woken seat not ready')).length, 2)
})

test('起こした席でも上限まで断られたら、起こし直さずその失敗を返す', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-failed-record-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { client, calls } = seatClient('agent_failed', undefined, { notReadySends: 9 })
  const transport = new AitermTransport({ client, handoffContext: async () => '', waitProcess: async () => ({ outcome: 'done' }) })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'codex', project: root }
  t.mock.method(process.stderr, 'write', () => true)

  await assert.rejects(transport.turn(bot, '再現用の本文'), error => error.code === 'BOT_INPUT_NOT_READY')

  assert.equal(calls.filter(([name]) => name === 'pty_send').length, 4)
  assert.equal(calls.filter(([name]) => name === 'agent_launch').length, 1)
})

test('元から居る席が入力受付の確認に通らない時は、閉じて起こし直してから同じ文を届ける', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-failed-record-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { client, calls } = seatClient('idle_timeout', undefined, { firstError: notReady })
  const transport = new AitermTransport({ client, handoffContext: async () => '', waitProcess: async () => ({ outcome: 'done' }) })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'codex', project: root }
  t.mock.method(process.stderr, 'write', () => true)

  await transport.turn(bot, '再現用の本文')

  assert.deepEqual(calls.map(([name]) => name), ['pty_send', 'pty_observe', 'pty_close', 'agent_launch', 'pty_send', 'pty_read'])
})

// 2026-11-08 本体入れ替え：端末は消えたがAitermが前の起動記録を残し、Claude席への送信が型の無い文で断られ続けた。
const replacedNative = 'aiterm: AGENT_RESUME_UNCONFIRMED: 作成したnative端末が置き換わっています。'
const absent = { schema: 'aiterm.pty-observe-result.v1', session_id: 'bot-a', exists: false, harness: null, launch_id: null, state: 'missing', reason: 'session_missing' }

test('端末が無い席は、断りの型や文言によらず、残った記録を閉じて起こしてから届ける', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-failed-record-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { client, calls } = seatClient('idle_timeout', undefined, { firstError: replacedNative, observed: absent })
  const transport = new AitermTransport({ client, handoffContext: async () => '', waitProcess: async () => ({ outcome: 'done' }) })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'claude', project: root }
  t.mock.method(process.stderr, 'write', () => true)

  await transport.turn(bot, '再現用の本文')

  assert.deepEqual(calls.map(([name]) => name), ['pty_send', 'pty_observe', 'pty_close', 'agent_launch', 'pty_send', 'pty_read'])
})

for (const [label, firstError, observed] of [
  ['動いているターンがある席', notReady, observation('agent_busy', 'busy')],
  ['端末があり未送信の明示が無い断り', replacedNative, observation('idle_timeout')],
]) test(`${label}は閉じずに元の失敗を返す`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-failed-record-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { client, calls } = seatClient('idle_timeout', undefined, { firstError, observed })
  const transport = new AitermTransport({ client, handoffContext: async () => '', waitProcess: async () => ({ outcome: 'done' }) })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'codex', project: root }

  await assert.rejects(transport.turn(bot, '再現用の本文'))

  assert.equal(calls.some(([name]) => ['pty_close', 'agent_launch'].includes(name)), false)
})
