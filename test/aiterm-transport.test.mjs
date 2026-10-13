import assert from 'node:assert/strict'
import { access, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AitermTransport, completedThroughlineTurns, latestThroughlineHandoffContext, cleanScreen } from '../src/aiterm-transport.mjs'

const noMemory = async () => ''

test('動いていない席を閉じている途中の送信は、閉じ終えてから一度だけ起き直す', async () => {
  let finishClose, signalClose
  const closeDone = new Promise(resolve => { finishClose = resolve })
  const closing = new Promise(resolve => { signalClose = resolve })
  const sends = []
  let closed = false, launches = 0
  const client = { async call(name, args) {
    if (name === 'pty_close') { signalClose(); await closeDone; closed = true; return {} }
    if (name === 'pty_list') return { content: [{ type: 'text', text: '(セッション無し)' }] }
    if (name === 'agent_launch') { launches++; return { structuredContent: { session_id: 'new-session' } } }
    if (name === 'pty_send') {
      sends.push(args.session_id)
      if (closed && args.session_id === 'old-session') throw new Error('SESSION_NOT_FOUND')
      return { structuredContent: { mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: '/node', args: [] } } }
    }
    if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: '続けるよ' } }
    throw new Error(`unexpected ${name}`)
  } }
  const transport = new AitermTransport({ client, handoffContext: noMemory, waitProcess: async () => ({ outcome: 'done' }) })
  const bot = { id: 'bot-a', session: 'old-session', harness: 'claude', project: await mkdtemp(join(tmpdir(), 'bellteam-idle-close-')) }
  const stopped = transport.closeIdle(bot)
  await closing
  assert.equal(await transport.closeIdle(bot), false)
  const next = transport.turn(bot, '続ける')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(sends, [])
  finishClose()
  assert.equal(await stopped, true)
  assert.equal(await next, '続けるよ')
  assert.deepEqual(sends, ['old-session', 'new-session'])
  assert.equal(launches, 1)
})

test('配送中の席は閉じず、閉じる処理の失敗は次の配送を永久に止めない', async () => {
  let calls = 0
  const transport = new AitermTransport({ client: { async call() { calls++; throw new Error('CLOSE_FAILED') } } })
  const bot = { id: 'bot-a', session: 'old-session' }
  transport.active.set('job', { bot })
  assert.equal(await transport.closeIdle(bot), false)
  assert.equal(calls, 0)
  transport.active.clear()
  await assert.rejects(transport.closeIdle(bot), /CLOSE_FAILED/u)
  assert.equal(transport.configurationChanges.has(bot.id), false)
})

test('設定反映のclose中に届いた次の送信は、閉じ終えてから新しいsessionへ渡す', async () => {
  let finishFirst, finishClose, signalClose
  const firstDone = new Promise(resolve => { finishFirst = resolve })
  const closeDone = new Promise(resolve => { finishClose = resolve })
  const closing = new Promise(resolve => { signalClose = resolve })
  const sent = []
  let closed = false
  const client = { async call(name, args) {
    if (name === 'pty_close') { signalClose(); await closeDone; closed = true; return {} }
    if (name === 'pty_list') return { content: [{ type: 'text', text: '(セッション無し)' }] }
    if (name === 'agent_launch') return { structuredContent: { session_id: 'new-session' } }
    if (name === 'pty_send') {
      if (closed && args.session_id === 'old-session') throw new Error('SESSION_NOT_FOUND')
      sent.push(args.session_id)
      return { structuredContent: { mode: 'agent_dispatch', event_cursor: sent.length, wait_process: { executable: '/node', args: [] } } }
    }
    if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: '返答' } }
    throw new Error(`unexpected ${name}`)
  } }
  let waits = 0
  const transport = new AitermTransport({ client, handoffContext: noMemory, waitProcess: async () => {
    if (++waits === 1) await firstDone
    return { outcome: 'done' }
  } })
  const bot = { id: 'bot-a', session: 'old-session', harness: 'codex', project: await mkdtemp(join(tmpdir(), 'bellteam-config-stop-')) }
  const first = transport.turn(bot, '設定する')
  await first.accepted
  const reload = transport.stopForConfiguration(bot)
  finishFirst()
  await first
  await closing
  const next = transport.turn(bot, '続ける')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(sent, ['old-session'])
  finishClose()
  await reload
  assert.equal(await next, '返答')
  assert.deepEqual(sent, ['old-session', 'new-session'])
})

test('設定反映のcloseが失敗したら、次の送信も旧登録へ渡さず理由を返す', async () => {
  const transport = new AitermTransport({ client: { async call(name) {
    assert.equal(name, 'pty_close')
    throw new Error('CLOSE_FAILED')
  } } })
  const bot = { id: 'bot-a', session: 'old-session' }
  await assert.rejects(transport.stopForConfiguration(bot), /CLOSE_FAILED/u)
  await assert.rejects(transport.turn(bot, '続ける'), /CLOSE_FAILED/u)
})

test('記録中のセッションへ不達なら新規起動し、返されたIDを保存して一度だけ再送する', async () => {
  const calls = []
  let sends = 0
  const updates = []
  const startups = []
  const client = {
    async call(name, args) {
      calls.push([name, args])
      if (name === 'pty_list') return { content: [{ type: 'text', text: '(セッション無し)' }] }
      if (name === 'agent_launch') {
        return { structuredContent: { session_id: 'grok-new', event_cursor: 1, wait_process: { executable: '/node', args: ['wait'] } } }
      }
      if (name === 'pty_send' && ++sends === 1) throw new Error('SESSION_NOT_FOUND')
      if (name === 'pty_send') return { structuredContent: {
        mode: 'agent_dispatch', event_cursor: 2, wait_process: { executable: '/node', args: ['wait'] },
      } }
      if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: '了解' } }
      throw new Error(`unexpected ${name}`)
    },
  }
  const transport = new AitermTransport({
    client, handoffContext: noMemory, waitProcess: async () => ({ outcome: 'done' }),
    prepareStartup: async (bot, shortTermMemory) => startups.push([bot.id, shortTermMemory]),
    updateSession: async (botId, session) => updates.push([botId, session]),
  })
  const bot = { id: 'bot-a', session: 'grok-old', harness: 'grok', project: await mkdtemp(join(tmpdir(), 'bellteam-owner-transport-')) }

  await transport.turn(bot, 'こんにちは')

  assert.deepEqual(updates, [['bot-a', 'grok-new']])
  assert.deepEqual(startups, [['bot-a', '']])
  assert.deepEqual(calls.filter(call => call[0] === 'pty_send').map(call => call[1].session_id), ['grok-old', 'grok-new'])
  assert.equal(calls.find(call => call[0] === 'agent_launch')[1].session_name, 'bot-a')
  assert.equal(calls.find(call => call[0] === 'agent_launch')[1].trust_project, true)
  assert.equal(calls.find(call => call[0] === 'agent_launch')[1].prompt, undefined)
  assert.equal(calls.filter(call => call[0] === 'pty_send').at(-1)[1].text, 'こんにちは')
  assert.deepEqual(calls.at(-1), ['pty_read', { session_id: 'grok-new', agent_transcript: true }])
})

test('新規起動後の再送も不達なら二度目をそのまま失敗にする', async () => {
  const calls = []
  const client = {
    async call(name, args) {
      calls.push([name, args])
      if (name === 'pty_list') return { content: [{ type: 'text', text: '(セッション無し)' }] }
      if (name === 'pty_send') throw new Error('SESSION_NOT_FOUND')
      if (name === 'agent_launch') return { structuredContent: { session_id: 'grok-new' } }
      throw new Error(`unexpected ${name}`)
    },
  }
  const transport = new AitermTransport({ client, handoffContext: noMemory })
  const bot = { id: 'bot-a', session: 'grok-old', harness: 'grok', project: await mkdtemp(join(tmpdir(), 'bellteam-redelivery-')) }

  await assert.rejects(transport.turn(bot, 'こんにちは'), /SESSION_NOT_FOUND/u)

  assert.deepEqual(calls.filter(call => call[0] === 'pty_send').map(call => call[1].session_id), ['grok-old', 'grok-new'])
  assert.equal(calls.filter(call => call[0] === 'agent_launch').length, 1)
})

test('起動の準備が終わらなかった席は残った端末を閉じ、起こし直さずに失敗を返し、次の送信でもう一度起こす', async () => {
  const calls = []
  let launches = 0
  const client = {
    async call(name, args) {
      calls.push([name, args])
      if (name === 'pty_list') return { content: [{ type: 'text', text: '(セッション無し)' }] }
      if (name === 'pty_send' && launches < 2) throw new Error('SESSION_NOT_FOUND')
      if (name === 'agent_launch' && ++launches === 1) {
        // 認証が切れたCLIがサインインの画面で止まった時のAitermの返事（0.52.2）。端末は作られて残る。
        throw Object.assign(new Error('aiterm: session_id: bot-a\n起動準備を完了できませんでした。reason=startup_dialog'), {
          launch: { schema: 'aiterm.agent-launch-result.v1', session_id: 'bot-a', startup: { status: 'blocked', reason: 'startup_dialog' } },
        })
      }
      if (name === 'agent_launch') return { structuredContent: { session_id: 'bot-a' } }
      if (name === 'pty_close') return { structuredContent: { outcome: 'closed' } }
      if (name === 'pty_send') return { structuredContent: { mode: 'agent_dispatch', event_cursor: 2, wait_process: { executable: '/node', args: ['wait'] } } }
      if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: '了解' } }
      throw new Error(`unexpected ${name}`)
    },
  }
  const transport = new AitermTransport({ client, handoffContext: noMemory, waitProcess: async () => ({ outcome: 'done' }) })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'codex', project: await mkdtemp(join(tmpdir(), 'bellteam-launch-not-ready-')) }

  await assert.rejects(transport.turn(bot, 'こんにちは'), error => {
    assert.match(error.message, /起動準備を完了できませんでした/u)
    assert.match(error.publicMessage, /メッセージは送信されませんでした。.*AIの認証が切れている可能性があります。/u)
    return true
  })
  assert.deepEqual(calls.map(call => call[0]), ['pty_send', 'pty_list', 'agent_launch', 'pty_close'])
  assert.deepEqual(calls.at(-1), ['pty_close', { session_id: 'bot-a' }])

  // 認証し直した後の次の送信は、残った端末に邪魔されず、普通に起きる。
  await transport.turn(bot, 'もう一度')
  assert.equal(calls.filter(call => call[0] === 'agent_launch').length, 2)
  assert.equal(calls.filter(call => call[0] === 'pty_close').length, 1)
  assert.equal(calls.filter(call => call[0] === 'pty_send').at(-1)[1].text, 'もう一度')
})

test('端末を作る前に失敗した起動は、端末を閉じず、理由の文も付けない', async () => {
  const calls = []
  const client = {
    async call(name, args) {
      calls.push([name, args])
      if (name === 'pty_list') return { content: [{ type: 'text', text: '(セッション無し)' }] }
      if (name === 'pty_send') throw new Error('SESSION_NOT_FOUND')
      if (name === 'agent_launch') throw new Error('aiterm: PTY_BACKEND_FAILED')
      throw new Error(`unexpected ${name}`)
    },
  }
  const transport = new AitermTransport({ client, handoffContext: noMemory })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'codex', project: await mkdtemp(join(tmpdir(), 'bellteam-launch-failed-')) }

  await assert.rejects(transport.turn(bot, 'こんにちは'), error => {
    assert.equal(error.message, 'aiterm: PTY_BACKEND_FAILED')
    assert.equal(error.publicMessage, undefined)
    return true
  })
  assert.deepEqual(calls.map(call => call[0]), ['pty_send', 'pty_list', 'agent_launch'])
})

test('BotのCLI名を四つのAiterm harnessへ変換する', async () => {
  const launches = []
  const client = {
    async call(name, args) {
      if (name === 'pty_list') return { content: [{ type: 'text', text: '(セッション無し)' }] }
      if (name === 'agent_launch') { launches.push(args); return { structuredContent: { session_id: `${args.harness}-new` } } }
      throw new Error(`unexpected ${name}`)
    },
  }
  const transport = new AitermTransport({ client, handoffContext: noMemory })
  const root = await mkdtemp(join(tmpdir(), 'bellteam-harnesses-'))
  for (const [harness, expected] of [
    ['claude', 'claude-code'], ['codex', 'codex-cli'], ['grok', 'grok-cli'], ['cursor', 'cursor-cli'],
  ]) {
    await transport.ensure({ id: harness, session: harness, harness, project: join(root, harness) })
    assert.equal(launches.at(-1).harness, expected)
  }
})

test('起動時にBot固有のモデルとエフォートをAitermへ渡す', async () => {
  const launches = []
  const client = {
    async call(name, args) {
      if (name === 'pty_list') return { content: [{ type: 'text', text: '(セッション無し)' }] }
      if (name === 'agent_launch') { launches.push(args); return { structuredContent: { session_id: 'codex-new' } } }
      throw new Error(`unexpected ${name}`)
    },
  }
  const transport = new AitermTransport({ client, handoffContext: noMemory })
  const project = await mkdtemp(join(tmpdir(), 'bellteam-model-effort-'))

  await transport.ensure({
    id: 'bot-a', session: 'bot-a', harness: 'codex', project,
    model: 'gpt-5.6-sol', reasoningEffort: 'high',
  })

  assert.equal(launches[0].model, 'gpt-5.6-sol')
  assert.equal(launches[0].reasoning_effort, 'high')
  assert.equal(launches[0].fast, false)
})

test('起動時のファストモードは、保存が有効のBotだけ有効で渡し、ほかは必ず無効で渡す', async () => {
  const launches = []
  const client = {
    async call(name, args) {
      if (name === 'pty_list') return { content: [{ type: 'text', text: '(セッション無し)' }] }
      if (name === 'agent_launch') { launches.push(args); return { structuredContent: { session_id: args.session_name } } }
      throw new Error(`unexpected ${name}`)
    },
  }
  const transport = new AitermTransport({ client, handoffContext: noMemory })
  const project = await mkdtemp(join(tmpdir(), 'bellteam-fast-launch-'))

  await transport.ensure({ id: 'bot-a', session: 'bot-a', harness: 'claude', project, model: 'opus', reasoningEffort: 'high', fastMode: true })
  await transport.ensure({ id: 'bot-b', session: 'bot-b', harness: 'claude', project, model: 'opus', reasoningEffort: 'high', fastMode: false })
  await transport.ensure({ id: 'bot-c', session: 'bot-c', harness: 'codex', project })

  assert.deepEqual(launches.map(launch => launch.fast), [true, false, false])
})

test('ファストモードで起こせず通常の速度で起きた席は、保存を無効へ合わせる', async () => {
  const updates = []
  const results = [{ session_id: 'bot-a', fast: false }, { session_id: 'bot-b', fast: true }, { session_id: 'bot-c', fast: false }, { session_id: 'bot-d' }]
  const client = {
    async call(name) {
      if (name === 'pty_list') return { content: [{ type: 'text', text: '(セッション無し)' }] }
      if (name === 'agent_launch') return { structuredContent: results.shift() }
      throw new Error(`unexpected ${name}`)
    },
  }
  const transport = new AitermTransport({ client, handoffContext: noMemory, updateFastMode: async (id, value) => updates.push([id, value]) })
  const project = await mkdtemp(join(tmpdir(), 'bellteam-fast-receipt-'))

  await transport.ensure({ id: 'bot-a', session: 'bot-a', harness: 'claude', project, fastMode: true })
  await transport.ensure({ id: 'bot-b', session: 'bot-b', harness: 'claude', project, fastMode: true })
  await transport.ensure({ id: 'bot-c', session: 'bot-c', harness: 'claude', project, fastMode: false })
  // 返りに状態が無い時（古いAiterm）は、保存を変えない。
  await transport.ensure({ id: 'bot-d', session: 'bot-d', harness: 'claude', project, fastMode: true })

  assert.deepEqual(updates, [['bot-a', false]])
})

test('ファストモードだけの切り替えは、会話セッションを保ってAitermへ渡す', async () => {
  const calls = []
  const transport = new AitermTransport({
    client: { async call(name, args) { calls.push([name, args]); return {} } },
    handoffContext: noMemory,
  })
  const current = { id: 'bot-a', session: 'bot-a', harness: 'claude', project: '/bots/bot-a', model: 'opus', reasoningEffort: 'high', fastMode: false }

  assert.deepEqual(await transport.reconfigure(current, { ...current, fastMode: true }), { botId: 'bot-a', session: 'bot-a', mode: 'configure' })
  assert.deepEqual(await transport.reconfigure({ ...current, fastMode: true }, current), { botId: 'bot-a', session: 'bot-a', mode: 'configure' })
  assert.deepEqual(calls, [
    ['agent_configure', { session_id: 'bot-a', fast: true }],
    ['agent_configure', { session_id: 'bot-a', fast: false }],
  ])
})

test('同じCLIのモデルとエフォートは会話セッションを保って変更する', async () => {
  const calls = []
  const transport = new AitermTransport({
    client: { async call(name, args) { calls.push([name, args]); return {} } },
    handoffContext: noMemory,
  })
  const current = { id: 'bot-a', session: 'bot-a', harness: 'codex', project: '/bots/bot-a', model: '', reasoningEffort: '' }
  const next = { ...current, model: 'gpt-5.6-sol', reasoningEffort: 'high' }

  assert.deepEqual(await transport.reconfigure(current, next), { botId: 'bot-a', session: 'bot-a', mode: 'configure' })
  assert.deepEqual(calls, [[
    'agent_configure',
    { session_id: 'bot-a', model: 'gpt-5.6-sol', reasoning_effort: 'high' },
  ]])
})

test('モデルとエフォートをCLI既定へ戻す時は記憶引き継ぎ付きで再起動する', async () => {
  const calls = []
  const project = await mkdtemp(join(tmpdir(), 'bellteam-model-default-'))
  const client = {
    async call(name, args) {
      calls.push([name, args])
      if (name === 'pty_close') return {}
      if (name === 'agent_launch') return { structuredContent: { session_id: 'codex-new' } }
      throw new Error(`unexpected ${name}`)
    },
  }
  const transport = new AitermTransport({ client, handoffContext: noMemory })
  const current = { id: 'bot-a', session: 'bot-a', harness: 'codex', project, model: 'gpt-5.6-sol', reasoningEffort: 'high' }
  const next = { ...current, model: '', reasoningEffort: '' }

  assert.deepEqual(await transport.reconfigure(current, next), { botId: 'bot-a', session: 'codex-new', mode: 'restart' })
  assert.deepEqual(calls, [
    ['pty_close', { session_id: 'bot-a' }],
    ['agent_launch', { harness: 'codex-cli', cwd: project, session_name: 'bot-a', trust_project: true, fast: false }],
  ])
})

test('Throughlineからproject限定かつ案内なしで、直近の複数セッションの短期記憶を一回で受け取る', async () => {
  const calls = []
  const context = await latestThroughlineHandoffContext('/srv/bellteam/bots/bot-a/project', {
    run: async (command, args) => {
      calls.push([command, args])
      // 0.15.0 の `--sessions recent` は、今までのキーに `sessions` を足して返す。
      return { stdout: JSON.stringify({
        schema: 'throughline.handoff_context.v1', status: 'ready',
        sessionId: 'codex:abc', context: '直近の会話文脈',
        sessions: [
          { sessionId: 'codex:abc', role: 'current', firstTurnAt: 2000, lastTurnAt: 3000, turns: 4, includedTurns: 4 },
          { sessionId: 'codex:old', role: 'past', firstTurnAt: 1000, lastTurnAt: 1500, turns: 9, includedTurns: 3 },
        ],
      }) }
    },
  })
  assert.equal(context, '直近の会話文脈')
  assert.deepEqual(calls, [[
    'throughline',
    [
      'handoff-context', '--project', '/srv/bellteam/bots/bot-a/project', '--json',
      '--disclosure', 'silent', '--sessions', 'recent',
    ],
  ]])
})

test('Throughlineが引数を受け付けずに止まった時は、呼び直さずに失敗を返す', async () => {
  // 0.14.3 以前は `--sessions` を知らず、終了コード2で止まる。版の前後は反映の順番で防ぎ、ここでは呼び直さない。
  let calls = 0
  await assert.rejects(latestThroughlineHandoffContext('/srv/bellteam/bots/bot-a/project', {
    run: async () => { calls += 1; throw Object.assign(new Error('Command failed: throughline handoff-context'), { code: 2 }) },
  }), /Command failed/u)
  assert.equal(calls, 1)
})

test('Throughlineに前回会話がなければ空の短期記憶を受け取る', async () => {
  const context = await latestThroughlineHandoffContext('/srv/bellteam/bots/bot-a/project', {
    run: async () => ({ stdout: JSON.stringify({
      schema: 'throughline.handoff_context.v1', status: 'empty', sessionId: null, context: '',
    }) }),
  })
  assert.equal(context, '')
})

test('Throughline Observerから現在セッションの完了ターン数だけを受け取る', async () => {
  const calls = []
  const count = await completedThroughlineTurns('/srv/bellteam/bots/bot-a/project', {
    run: async (command, args) => {
      calls.push([command, args])
      return { stdout: JSON.stringify({ schema: 'throughline.observer_read.v1', turns: Array(20).fill({}) }) }
    },
  })
  assert.equal(count, 20)
  assert.deepEqual(calls, [[
    'throughline',
    ['observer-read', '--project', '/srv/bellteam/bots/bot-a/project', '--limit', '20', '--json'],
  ]])
})

test('停止後は短期記憶を起動指示へ準備してからプロンプトなしで起動する', async () => {
  const launches = []
  const startups = []
  const project = await mkdtemp(join(tmpdir(), 'bellteam-throughline-restore-'))
  const client = {
    async call(name, args) {
      if (name === 'pty_list') return { content: [{ type: 'text', text: '(セッション無し)' }] }
      if (name === 'agent_launch') {
        launches.push(args)
        return { structuredContent: { session_id: 'cursor-new', event_cursor: null } }
      }
      throw new Error(`unexpected ${name}`)
    },
  }
  const transport = new AitermTransport({
    client,
    handoffContext: async projectPath => `短期記憶:${projectPath}`,
    prepareStartup: async (bot, memory) => startups.push([bot.id, memory]),
  })
  await transport.ensure({ id: 'bot-a', session: 'bot-a', harness: 'cursor', project })

  assert.deepEqual(launches, [{
    harness: 'cursor-cli',
    cwd: project,
    session_name: 'bot-a',
    trust_project: true,
    fast: false,
  }])
  assert.deepEqual(startups, [['bot-a', `短期記憶:${project}`]])
})

test('長期記憶とRAGは起動引数へ渡さない', async () => {
  const launches = []
  const startups = []
  const project = await mkdtemp(join(tmpdir(), 'bellteam-no-long-term-startup-'))
  const client = {
    async call(name, args) {
      if (name === 'pty_list') return { content: [{ type: 'text', text: '(セッション無し)' }] }
      if (name === 'agent_launch') {
        launches.push(args)
        return { structuredContent: { session_id: 'claude-new', event_cursor: null } }
      }
      throw new Error(`unexpected ${name}`)
    },
  }
  const transport = new AitermTransport({
    client,
    handoffContext: async () => '前セッションの短期記憶だけ',
    prepareStartup: async (_bot, memory) => startups.push(memory),
  })
  await transport.ensure({ id: 'bot-a', session: 'bot-a', harness: 'claude', project })

  assert.deepEqual(startups, ['前セッションの短期記憶だけ'])
  assert.deepEqual(launches, [{ harness: 'claude-code', cwd: project, session_name: 'bot-a', trust_project: true, fast: false }])
})

test('ユーザーターンはAitermの完了後に確定回答を回収し、複数の画像一時ファイルを削除する', async () => {
  const calls = []
  let imagePaths
  const client = {
    async call(name, args) {
      calls.push([name, args])
      if (name === 'pty_list') return { content: [{ type: 'text', text: '(セッション無し)' }] }
      if (name === 'agent_launch') return { structuredContent: { session_id: 'bot-a', event_cursor: null } }
      if (name === 'pty_send') {
        imagePaths = args.image
        await Promise.all(imagePaths.map(path => access(path)))
      }
      if (name === 'pty_send') return {
        structuredContent: {
          mode: 'agent_dispatch', session_id: 'bot-a', event_cursor: 17,
          wait_process: { executable: '/node', args: ['aiterm-wait', '--session', 'bot-a', '--cursor', '17'] },
        },
      }
      if (name === 'pty_read') return {
        content: [{ type: 'text', text: '内部表示\n[agent_transcript vendor=grok]' }],
        structuredContent: {
          schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: '画像には青い鳥がいます。',
          session_id: 'bot-a', vendor: 'grok', turn_id: 'turn-1', harness: 'grok-cli', raw_chars: 13,
        },
      }
      throw new Error(`unexpected ${name}`)
    },
  }
  const transport = new AitermTransport({
    client,
    handoffContext: noMemory,
    tempRoot: await mkdtemp(join(tmpdir(), 'bellteam-aiterm-')),
    waitProcess: async process => {
      calls.push(['wait', process])
      return { outcome: 'done' }
    },
  })
  const project = await mkdtemp(join(tmpdir(), 'bellteam-bot-'))
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'grok', project }

  const answer = await transport.turn(bot, 'この画像を見て', {
    images: [{ mime: 'image/png', data: 'iVBORw0KGgo=' }, { mime: 'image/jpeg', data: '/9j/4A==' }],
  })

  assert.equal(answer, '画像には青い鳥がいます。')
  assert.equal(calls[0][0], 'pty_send')
  assert.equal(calls[0][1].session_id, 'bot-a')
  assert.equal(calls[0][1].text, 'この画像を見て')
  assert.equal(calls[0][1].force, undefined)
  assert.equal(imagePaths.length, 2)
  assert.match(imagePaths[0], /\.png$/u)
  assert.match(imagePaths[1], /\.jpg$/u)
  assert.deepEqual(calls.at(-1), ['pty_read', { session_id: 'bot-a', agent_transcript: true }])
  for (const path of imagePaths) await assert.rejects(access(path), /ENOENT/u)
})

test('処理中のBotへの連絡はBellTeamで待たずAitermの送信口へ渡す', async () => {
  const calls = []
  let finish
  const waiting = new Promise(resolve => { finish = resolve })
  const client = {
    async call(name, args) {
      calls.push([name, args])
      if (name === 'pty_send') return { structuredContent: calls.filter(([tool]) => tool === 'pty_send').length === 1
        ? { mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: '/node', args: ['wait'] } }
        : { mode: 'agent_steer', event_cursor: null, wait_process: null } }
      if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: '了解' } }
      throw new Error(`unexpected ${name}`)
    },
  }
  const transport = new AitermTransport({ client, handoffContext: noMemory, waitProcess: async () => waiting })
  const bot = { id: 'bot-b', session: 'bot-b', harness: 'claude', project: '/bots/bot-b' }
  const first = transport.turn(bot, '最初の依頼', { queue: { context: 'direct' } })
  assert.deepEqual(await first.accepted, { delivery: 'running' })
  const statuses = []
  const turnEnds = []
  const second = await transport.notify(bot, '追加の依頼', {
    queue: { context: 'direct', message: '追加の依頼' },
    onStatus: status => statuses.push(status),
    onTurnEnd: window => turnEnds.push(window),
  })
  assert.deepEqual(second, { delivery: 'steered' })
  assert.deepEqual(calls.filter(([name]) => name === 'pty_send').map(([, args]) => args.text), ['最初の依頼', '追加の依頼'])
  assert.deepEqual(transport.queueItems({ botId: bot.id }).map(item => item.status), ['running', 'running'])
  finish({ outcome: 'done' })
  assert.equal(await first, '了解')
  await transport.idle(bot.id)
  assert.deepEqual(statuses, ['running', 'delivered'])
  // 差し込みは元のターンの一部なので、ターンの終わりとして扱わない。
  assert.deepEqual(turnEnds, [])
  assert.deepEqual(transport.queueItems({ botId: bot.id }), [])
})

test('新しく始まった通知のターンが終わると、その時間の幅をonTurnEndへ渡す', async () => {
  let clock = 0
  const transport = new AitermTransport({
    client: { async call(name) {
      if (name === 'pty_send') return { structuredContent: { mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: '/node', args: ['wait'] } } }
      if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: '返したよ' } }
      throw new Error(`unexpected ${name}`)
    } },
    handoffContext: noMemory, waitProcess: async () => ({ outcome: 'done' }),
    now: () => `2026-10-01T00:00:0${clock++}.000Z`,
  })
  const bot = { id: 'bot-b', session: 'bot-b', harness: 'claude', project: '/bots/bot-b' }
  const order = []
  await transport.notify(bot, '依頼', {
    onAnswer: text => order.push(['answer', text]),
    onStatus: status => order.push(['status', status]),
    onTurnEnd: window => order.push(['end', window]),
  })
  await transport.idle(bot.id)
  assert.deepEqual(order, [
    ['status', 'running'], ['answer', '返したよ'], ['status', 'delivered'],
    ['end', { startedAt: '2026-10-01T00:00:00.000Z', endedAt: '2026-10-01T00:00:01.000Z' }],
  ])
})

test('ユーザー追加指示もpty_send一回でAitermへ渡し、差し込みなら別回答を作らない', async () => {
  const calls = []
  let finish
  const waiting = new Promise(resolve => { finish = resolve })
  const transport = new AitermTransport({
    client: { async call(name, args) {
      calls.push([name, args])
      if (name === 'pty_send') return { structuredContent: calls.filter(([tool]) => tool === 'pty_send').length === 1
        ? { mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: '/node', args: ['wait'] } }
        : { mode: 'agent_steer', event_cursor: null, wait_process: null } }
      if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: 'まとめて回答' } }
      throw new Error(`unexpected ${name}`)
    } },
    handoffContext: noMemory, waitProcess: async () => waiting,
  })
  const bot = { id: 'bot-b', session: 'bot-b', harness: 'claude', project: '/bots/bot-b' }
  const first = transport.turn(bot, '最初', { queue: { context: 'direct' } })
  await first.accepted
  const followup = transport.turn(bot, '追加', { queue: { context: 'direct' } })
  assert.deepEqual(await followup.accepted, { delivery: 'steered' })
  assert.deepEqual(calls.filter(([name]) => name === 'pty_send').map(([, args]) => args.text), ['最初', '追加'])
  finish({ outcome: 'done' })
  assert.equal(await first, 'まとめて回答')
  assert.deepEqual(await followup, { delivery: 'steered' })
})

test('何人ものBotの席が動いているかは、pty_listを1回だけ呼んで調べる', async () => {
  const calls = []
  const transport = new AitermTransport({
    client: { async call(name) {
      calls.push(name)
      return { content: [{ type: 'text', text: 'bot-a\tclaude\nbot-c\tnode' }] }
    } },
    handoffContext: noMemory,
  })
  const bots = ['bot-a', 'bot-b', 'bot-c'].map(id => ({ id, session: id, harness: 'claude', project: `/bots/${id}` }))
  assert.deepEqual([...await transport.runningBots(bots)], ['bot-a', 'bot-c'])
  assert.deepEqual(calls, ['pty_list'])
  assert.equal(await transport.isRunning(bots[1]), false)
  assert.equal(await transport.isRunning(bots[2]), true)
})

test('Aitermの送信失敗は待機に戻さずfailedとして返す', async () => {
  const calls = []
  const transport = new AitermTransport({
    client: { async call(name) {
      calls.push(name)
      if (name === 'pty_list') return { content: [{ type: 'text', text: 'bot-b\tnode' }] }
      throw new Error('STEER_NOT_QUEUED')
    } },
    handoffContext: noMemory,
  })
  const bot = { id: 'bot-b', session: 'bot-b', harness: 'claude', project: '/bots/bot-b' }
  const statuses = []
  const completion = transport.turn(bot, '追加指示', { onStatus: status => statuses.push(status) })
  await assert.rejects(completion.accepted, /STEER_NOT_QUEUED/u)
  await assert.rejects(completion, /STEER_NOT_QUEUED/u)
  assert.deepEqual(statuses, ['failed'])
  assert.deepEqual(calls, ['pty_send', 'pty_list'])
  assert.deepEqual(transport.queueItems({ botId: bot.id }), [])
})

test('Aitermが新規ターンを返したらBellTeamは前の完了を待たず受け付ける', async () => {
  const calls = []
  const finishes = []
  const transport = new AitermTransport({
    client: { async call(name, args) {
      calls.push([name, args])
      if (name === 'pty_send') return { structuredContent: {
        mode: 'agent_dispatch', event_cursor: calls.filter(([tool]) => tool === 'pty_send').length,
        wait_process: { executable: '/node', args: [String(calls.filter(([tool]) => tool === 'pty_send').length)] },
      } }
      throw new Error(`unexpected ${name}`)
    } },
    handoffContext: noMemory,
    waitProcess: ({ args }) => new Promise(resolve => { finishes[Number(args[0])] = resolve }),
  })
  const bot = { id: 'bot-b', session: 'bot-b', harness: 'grok', project: '/bots/bot-b' }
  const first = await transport.notify(bot, '一件目')
  const second = await transport.notify(bot, '二件目')
  assert.deepEqual(first, { delivery: 'running' })
  assert.deepEqual(second, { delivery: 'running' })
  assert.equal(calls.filter(([name]) => name === 'pty_send').length, 2)
  assert.deepEqual(transport.queueItems({ botId: bot.id }).map(item => item.status), ['running', 'running'])
  finishes[1]({ outcome: 'done' })
  finishes[2]({ outcome: 'done' })
  await transport.idle(bot.id)
})

test('完了したターンと別の回答を会話へ混ぜない', async () => {
  const transport = new AitermTransport({
    client: { async call(name) {
      if (name === 'pty_send') return { structuredContent: {
        mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: '/node', args: ['wait'] },
      } }
      if (name === 'pty_read') return { structuredContent: {
        schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', turn_id: '別のターン', text: '別の回答',
      } }
      throw new Error(`unexpected ${name}`)
    } },
    handoffContext: noMemory,
    waitProcess: async () => ({ outcome: 'done', turn_id: '対象のターン' }),
  })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'grok', project: '/bots/bot-a' }
  await assert.rejects(transport.turn(bot, '確認'), /AITERM_TRANSCRIPT_TURN_MISMATCH/u)
})

test('BellTeam外で実行中のターンへ差し込んだ画像は次のターンまで保持する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-image-steer-'))
  let imagePath
  let sends = 0
  const transport = new AitermTransport({
    tempRoot: root,
    client: { async call(name, args) {
      if (name === 'pty_send') {
        sends++
        if (sends === 1) {
          imagePath = args.image[0]
          return { structuredContent: { mode: 'agent_steer' } }
        }
        return { structuredContent: {
          mode: 'agent_dispatch', event_cursor: 2, wait_process: { executable: '/node', args: ['wait'] },
        } }
      }
      throw new Error(`unexpected ${name}`)
    } },
    handoffContext: noMemory,
    waitProcess: async () => ({ outcome: 'done' }),
  })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'grok', project: '/bots/bot-a' }
  assert.deepEqual(await transport.notify(bot, '画像を見て', { images: [{ mime: 'image/png', data: 'iVBORw0KGgo=' }] }), { delivery: 'steered' })
  await transport.idle(bot.id)
  await access(imagePath)
  assert.deepEqual(await transport.notify(bot, '次の依頼'), { delivery: 'running' })
  await transport.idle(bot.id)
  await assert.rejects(access(imagePath), /ENOENT/u)
})

test('Botセッションを閉じて新しいセッションIDで起動し直す', async () => {
  const calls = []
  const project = await mkdtemp(join(tmpdir(), 'bellteam-restart-'))
  const client = {
    async call(name, args) {
      calls.push([name, args])
      if (name === 'pty_close') return {}
      if (name === 'agent_launch') return { structuredContent: { session_id: 'grok-new' } }
      throw new Error(`unexpected ${name}`)
    },
  }
  const transport = new AitermTransport({ client, handoffContext: noMemory })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'grok', project }

  assert.deepEqual(await transport.restart(bot), { botId: 'bot-a', session: 'grok-new' })
  assert.deepEqual(calls, [
    ['pty_close', { session_id: 'bot-a' }],
    ['agent_launch', { harness: 'grok-cli', cwd: project, session_name: 'bot-a', trust_project: true, fast: false }],
  ])
})

test('処理中のBotは日次再起動を受け付けない', async () => {
  const calls = []
  let finish
  const transport = new AitermTransport({
    client: { async call(name, args) {
      calls.push([name, args])
      if (name === 'pty_send') return { structuredContent: {
        mode: 'agent_dispatch', event_cursor: 1,
        wait_process: { executable: '/node', args: ['wait'] },
      } }
      if (name === 'pty_read') return { structuredContent: {
        schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: '了解',
      } }
      throw new Error(`unexpected ${name}`)
    } },
    handoffContext: noMemory,
    waitProcess: () => new Promise(resolve => { finish = resolve }),
  })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'grok', project: '/bots/bot-a' }
  const turn = transport.turn(bot, '処理中')
  await turn.accepted

  assert.deepEqual(await transport.restartIfIdle(bot), { restarted: false, reason: 'busy' })
  assert.deepEqual(calls.map(([name]) => name), ['pty_send'])

  finish({ outcome: 'done' })
  await transport.idle(bot.id)
})

test('Bot削除前にAitermセッションを閉じる', async () => {
  const calls = []
  const transport = new AitermTransport({ client: { async call(name, args) { calls.push([name, args]); return {} } }, handoffContext: noMemory })
  const bot = { id: 'bot-a', session: 'bot-a' }

  await transport.stop(bot)

  assert.deepEqual(calls, [['pty_close', { session_id: 'bot-a' }]])
})

test('画面整形は起動コマンドの塊を落とし、空行をまとめ、末尾だけ返す', () => {
  const raw = [
    "bell@abc:/app$ cd '/srv/bellteam/bots/bot-a' && GROK_AUTH_PATH='x' '/usr/local/bin/grok' --rules '<aiterm_subagent_context>",
    '> role=subagent',
    "> </aiterm_subagent_context>'",
    '   ',
    '',
    '',
    '  ❯ 「オーナー」からあなたへ次のメッセージが届いています。   ',
    '',
    '',
    '  ⠦ Waiting for response… 4.1s',
    '',
    '',
  ].join('\n')
  assert.equal(cleanScreen(raw), '  ❯ 「オーナー」からあなたへ次のメッセージが届いています。\n\n  ⠦ Waiting for response… 4.1s')
  assert.equal(cleanScreen('a\nb\nc\nd', 2), 'c\nd')
})

test('ターンがAPIエラーで打ち切られた時は本文付きのAITERM_TURN_ERRORで失敗にする', async () => {
  const client = {
    async call(name) {
      if (name === 'pty_send') return {
        structuredContent: {
          mode: 'agent_dispatch', session_id: 'bot-a', event_cursor: 3,
          wait_process: { executable: '/node', args: ['aiterm-wait', '--session', 'bot-a', '--cursor', '3'] },
        },
      }
      throw new Error(`unexpected ${name}`)
    },
  }
  const transport = new AitermTransport({
    client,
    handoffContext: noMemory,
    tempRoot: await mkdtemp(join(tmpdir(), 'bellteam-aiterm-')),
    waitProcess: async () => ({ outcome: 'error', error: 'API Error: 529 Overloaded. This is a server-side issue' }),
  })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'claude', project: await mkdtemp(join(tmpdir(), 'bellteam-bot-')) }

  await assert.rejects(transport.turn(bot, '確認して'), /^Error: AITERM_TURN_ERROR: API Error: 529 Overloaded/u)
})

function interimClient({ observe, calls = [] }) {
  return {
    async call(name, args, options) {
      calls.push([name, args, options])
      if (name === 'pty_send') return {
        structuredContent: {
          mode: 'agent_dispatch', session_id: 'bot-a', event_cursor: 40,
          wait_process: { executable: '/node', args: ['aiterm-wait', '--session', 'bot-a', '--cursor', '40'] },
        },
      }
      if (name === 'pty_observe') return { structuredContent: { state: 'busy' }, ...observe(options.meta['aiterm/interim_after']) }
      if (name === 'pty_read') return {
        structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: '直したよ', session_id: 'bot-a' },
      }
      throw new Error(`unexpected ${name}`)
    },
  }
}

function interimWords(eventCursor, words) {
  return { _meta: { 'aiterm/interim_words': {
    schema: 'aiterm.interim-words.v1', session_id: 'bot-a', event_cursor: eventCursor, last_seq: words.at(-1)?.seq ?? 0, words,
  } } }
}

test('実行中のターンの合間の言葉をBellTeam指定のpty_observeで順番に受け取り、完了後にもう一度読む', async () => {
  const calls = []
  const written = [
    { seq: 1, text: 'ちょっと見てくるね', kind: 'interim', at: '2026-09-28T01:00:01.000Z', turn_id: null },
    { seq: 2, text: 'あ、ここ壊れてた', kind: 'interim', at: null, turn_id: null },
  ]
  let visible = 0
  const client = interimClient({ calls, observe: after => interimWords(40, written.slice(0, visible).filter(word => word.seq > after)) })
  const transport = new AitermTransport({
    client, handoffContext: noMemory, interimInterval: 5,
    tempRoot: await mkdtemp(join(tmpdir(), 'bellteam-aiterm-')),
    waitProcess: async () => {
      visible = 1
      await new Promise(resolve => setTimeout(resolve, 40))
      visible = 2
      return { outcome: 'done' }
    },
  })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'claude', project: await mkdtemp(join(tmpdir(), 'bellteam-bot-')) }
  const received = []

  const answer = await transport.turn(bot, '見てくれる？', { onInterim: async words => received.push(...words) })

  assert.equal(answer, '直したよ')
  assert.deepEqual(received, [
    { text: 'ちょっと見てくるね', kind: 'interim', at: '2026-09-28T01:00:01.000Z' },
    { text: 'あ、ここ壊れてた', kind: 'interim' },
  ])
  const observes = calls.filter(([name]) => name === 'pty_observe')
  assert.deepEqual(observes[0].slice(1), [{ session_id: 'bot-a' }, { meta: { 'aiterm/caller': 'BellTeam', 'aiterm/interim_after': 0 } }])
  assert.equal(observes.at(-1)[2].meta['aiterm/interim_after'], 1)
  assert.equal(calls.at(-1)[0], 'pty_read')
})

test('別のターンの言葉と、合間の言葉を返さない版のAitermは受け取らずにターンを終える', async () => {
  for (const observe of [() => interimWords(39, [{ seq: 1, text: '前のターン', kind: 'interim', at: null }]), () => ({})]) {
    const transport = new AitermTransport({
      client: interimClient({ observe }), handoffContext: noMemory, interimInterval: 5,
      tempRoot: await mkdtemp(join(tmpdir(), 'bellteam-aiterm-')),
      waitProcess: async () => { await new Promise(resolve => setTimeout(resolve, 20)); return { outcome: 'done' } },
    })
    const bot = { id: 'bot-a', session: 'bot-a', harness: 'grok', project: await mkdtemp(join(tmpdir(), 'bellteam-bot-')) }
    const received = []
    assert.equal(await transport.turn(bot, '確認して', { onInterim: async words => received.push(...words) }), '直したよ')
    assert.deepEqual(received, [])
  }
})

test('利用上限で止まったターンは、Aitermの上限の知らせを理由に残して合間の言葉として出す', async () => {
  const cases = [
    [{ outcome: 'rate_limited', rate_limit: "You've hit your limit · resets 3pm (UTC)" }, "AITERM_TURN_RATE_LIMITED: You've hit your limit · resets 3pm (UTC)"],
    [{ outcome: 'rate_limited', rate_limit: null }, 'AITERM_TURN_RATE_LIMITED'],
  ]
  for (const [result, reason] of cases) {
    const transport = new AitermTransport({
      client: interimClient({ observe: () => interimWords(40, []) }), handoffContext: noMemory, interimInterval: 5,
      tempRoot: await mkdtemp(join(tmpdir(), 'bellteam-aiterm-')),
      waitProcess: async () => result,
    })
    const bot = { id: 'bot-a', session: 'bot-a', harness: 'claude', project: await mkdtemp(join(tmpdir(), 'bellteam-bot-')) }
    const received = []
    await assert.rejects(transport.turn(bot, '確認して', { onInterim: async words => received.push(...words) }), error => error.message === reason)
    assert.deepEqual(received, [{ text: reason, kind: 'error' }])
  }
})

test('通知で始まったターンは最後の回答をonAnswerへ渡し、読めない時も配送は完了にする', async () => {
  for (const [read, expected] of [[async () => ({
    structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: '3か所を返したよ', session_id: 'bot-a' },
  }), ['3か所を返したよ']], [async () => { throw new Error('read failed') }, []], [async () => ({
    structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: '  ', session_id: 'bot-a' },
  }), []]]) {
    const base = interimClient({ observe: () => interimWords(40, []) })
    const client = { async call(name, args, options) { return name === 'pty_read' ? read() : base.call(name, args, options) } }
    const transport = new AitermTransport({
      client, handoffContext: noMemory, interimInterval: 5,
      tempRoot: await mkdtemp(join(tmpdir(), 'bellteam-aiterm-')),
      waitProcess: async () => ({ outcome: 'done' }),
    })
    const bot = { id: 'bot-a', session: 'bot-a', harness: 'claude', project: await mkdtemp(join(tmpdir(), 'bellteam-bot-')) }
    const answers = []
    const statuses = []
    let finished
    const done = new Promise(resolve => { finished = resolve })
    await transport.notify(bot, '見てくれる？', {
      onAnswer: async text => answers.push(text),
      onStatus: async status => { statuses.push(status); if (status !== 'running') finished() },
    })
    await done
    assert.deepEqual(answers, expected)
    assert.deepEqual(statuses, ['running', 'delivered'])
  }
})

test('合間の言葉を求めない配送ではpty_observeを呼ばない', async () => {
  const calls = []
  const transport = new AitermTransport({
    client: interimClient({ calls, observe: () => ({}) }), handoffContext: noMemory, interimInterval: 5,
    tempRoot: await mkdtemp(join(tmpdir(), 'bellteam-aiterm-')),
    waitProcess: async () => { await new Promise(resolve => setTimeout(resolve, 20)); return { outcome: 'done' } },
  })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'grok', project: await mkdtemp(join(tmpdir(), 'bellteam-bot-')) }
  await transport.turn(bot, '確認して')
  assert.equal(calls.some(([name]) => name === 'pty_observe'), false)
})

test('エラーで終わったターンは、Claudeのエラーの知らせを合間の言葉として出し、無いハーネスではAitermの理由を出す', async () => {
  const cases = [
    [[{ seq: 1, text: 'API Error: 529 Overloaded', kind: 'error', at: null }], [{ text: 'API Error: 529 Overloaded', kind: 'error' }]],
    [[], [{ text: 'AITERM_TURN_ERROR: turn_ended outcome=error', kind: 'error' }]],
  ]
  for (const [written, expected] of cases) {
    const transport = new AitermTransport({
      client: interimClient({ observe: after => interimWords(40, written.filter(word => word.seq > after)) }),
      handoffContext: noMemory, interimInterval: 5,
      tempRoot: await mkdtemp(join(tmpdir(), 'bellteam-aiterm-')),
      waitProcess: async () => ({ outcome: 'error', error: 'turn_ended outcome=error' }),
    })
    const bot = { id: 'bot-a', session: 'bot-a', harness: 'claude', project: await mkdtemp(join(tmpdir(), 'bellteam-bot-')) }
    const received = []
    await assert.rejects(transport.turn(bot, '確認して', { onInterim: async words => received.push(...words) }), /AITERM_TURN_ERROR/u)
    assert.deepEqual(received, expected)
  }
})

// Aiterm 0.60.0（ADR 0122）がBellTeamの印の付いた差し込みへ返す形。
function steerReceipt({ cursor = 40, steerId = '0123456789abcdef' } = {}) {
  return {
    structuredContent: {
      schema: 'aiterm.pty-send-result.v1', mode: 'agent_steer', session_id: 'bot-a', event_cursor: cursor,
      wait_process: { executable: '/node', args: ['aiterm-wait', '--session', 'bot-a', '--cursor', String(cursor), '--steer', steerId] },
    },
    _meta: { 'aiterm/steer': { schema: 'aiterm.steer-ref.v1', steer_id: steerId, interim_from: `v1:${cursor}:b:900` } },
  }
}

test('BellTeamが始めていないターンへの差し込みは、その文を取ったターンの終わりまで処理中に出し、合間の言葉を出す', async () => {
  const calls = []
  const waits = []
  let finish
  const waiting = new Promise(resolve => { finish = resolve })
  const written = [{ seq: 1, text: '見てくるね', kind: 'interim', at: null, turn_id: null }]
  const transport = new AitermTransport({
    client: { async call(name, args, options) {
      calls.push([name, args, options])
      if (name === 'pty_send') return steerReceipt()
      if (name === 'pty_observe')
        return { structuredContent: { state: 'busy' }, ...interimWords(40, written.filter(word => word.seq > options.meta['aiterm/interim_after'])) }
      throw new Error(`unexpected ${name}`)
    } },
    handoffContext: noMemory, interimInterval: 5,
    waitProcess: async process => { waits.push(process); return waiting },
  })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'codex', project: '/bots/bot-a' }
  const statuses = [], words = [], answers = [], turnEnds = []
  const accepted = await transport.notify(bot, '追加の依頼', {
    onStatus: status => statuses.push(status), onInterim: batch => words.push(...batch),
    onAnswer: text => answers.push(text), onTurnEnd: window => turnEnds.push(window),
  })
  assert.deepEqual(accepted, { delivery: 'steered' })
  assert.deepEqual(statuses, ['running'])
  assert.deepEqual(transport.queueItems({ botId: bot.id }).map(item => item.status), ['running'])
  finish({ outcome: 'done', turn_id: 'turn-x', steer: { placement: 'same_turn', taken_at: null } })
  await transport.idle(bot.id)
  assert.deepEqual(statuses, ['running', 'delivered'])
  assert.deepEqual(words, [{ text: '見てくるね', kind: 'interim' }])
  // そのターンの回答は、ターンを始めた側が出す。差し込みの側では読まない。
  assert.deepEqual(answers, [])
  assert.deepEqual(turnEnds, [])
  assert.equal(calls.some(([name]) => name === 'pty_read'), false)
  assert.deepEqual(calls.find(([name]) => name === 'pty_send')[2], { meta: { 'aiterm/caller': 'BellTeam' } })
  assert.deepEqual(calls.find(([name]) => name === 'pty_observe')[2],
    { meta: { 'aiterm/caller': 'BellTeam', 'aiterm/interim_after': 0, 'aiterm/interim_from': 'v1:40:b:900' } })
  assert.deepEqual(waits[0].args.slice(-2), ['--steer', '0123456789abcdef'])
  assert.deepEqual(transport.queueItems({ botId: bot.id }), [])
})

test('前のターンが終わった後で新しいターンになった差し込みは、そのターンの回答を読む', async () => {
  const reads = []
  const transport = new AitermTransport({
    client: { async call(name, args) {
      if (name === 'pty_send') return steerReceipt()
      if (name === 'pty_read') {
        reads.push(args)
        return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: '答えたよ', turn_id: 'turn-y' } }
      }
      throw new Error(`unexpected ${name}`)
    } },
    handoffContext: noMemory, now: () => '2026-10-13T12:00:00.000Z',
    waitProcess: async () => ({ outcome: 'done', turn_id: 'turn-y', steer: { placement: 'next_turn', taken_at: '2026-10-13T12:00:01.000Z' } }),
  })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'codex', project: '/bots/bot-a' }
  const user = transport.turn(bot, '頼む')
  assert.deepEqual(await user.accepted, { delivery: 'steered' })
  assert.equal(await user, '答えたよ')
  const order = []
  await transport.notify(bot, '連絡', {
    onStatus: status => order.push(['status', status]), onAnswer: text => order.push(['answer', text]),
    onTurnEnd: window => order.push(['end', window]),
  })
  await transport.idle(bot.id)
  assert.deepEqual(order, [
    ['status', 'running'], ['answer', '答えたよ'], ['status', 'delivered'],
    ['end', { startedAt: '2026-10-13T12:00:00.000Z', endedAt: '2026-10-13T12:00:00.000Z' }],
  ])
  assert.deepEqual(reads, [{ session_id: 'bot-a', agent_transcript: true }, { session_id: 'bot-a', agent_transcript: true }])
})

test('追っているターンへの差し込みは、合間の言葉も回答も重ねず、元の配送の終わりを待って配達済みにする', async () => {
  const calls = []
  let finishTurn, finishSteer
  const turnDone = new Promise(resolve => { finishTurn = resolve })
  const steerDone = new Promise(resolve => { finishSteer = resolve })
  const transport = new AitermTransport({
    client: { async call(name, args, options) {
      calls.push([name, args, options])
      if (name === 'pty_send') return calls.filter(([tool]) => tool === 'pty_send').length === 1
        ? { structuredContent: { mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: '/node', args: ['wait'] } } }
        : steerReceipt()
      if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: 'まとめて回答' } }
      throw new Error(`unexpected ${name}`)
    } },
    handoffContext: noMemory, interimInterval: 5,
    waitProcess: async process => process.args.includes('--steer') ? steerDone : turnDone,
  })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'codex', project: '/bots/bot-a' }
  const first = transport.turn(bot, '最初')
  await first.accepted
  const statuses = []
  const second = transport.turn(bot, '追加', { onStatus: status => statuses.push(status), onInterim: () => { throw new Error('合間の言葉は元の配送が出す') } })
  assert.deepEqual(await second.accepted, { delivery: 'steered' })
  finishSteer({ outcome: 'done', turn_id: 'turn-x', steer: { placement: 'same_turn', taken_at: null } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(statuses, ['running'])
  finishTurn({ outcome: 'done' })
  assert.equal(await first, 'まとめて回答')
  assert.deepEqual(await second, { delivery: 'steered' })
  assert.deepEqual(statuses, ['running', 'delivered'])
  assert.equal(calls.some(([name]) => name === 'pty_observe'), false)
  assert.equal(calls.filter(([name]) => name === 'pty_read').length, 1)
})

test('会話の記録に入らなかった差し込みは、failedにする', async () => {
  const transport = new AitermTransport({
    client: { async call(name) {
      if (name === 'pty_send') return steerReceipt()
      throw new Error(`unexpected ${name}`)
    } },
    handoffContext: noMemory, waitProcess: async () => ({ outcome: 'not_taken' }),
  })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'claude', project: '/bots/bot-a' }
  const statuses = []
  const completion = transport.turn(bot, '届いて', { onStatus: status => statuses.push(status) })
  assert.deepEqual(await completion.accepted, { delivery: 'steered' })
  await assert.rejects(completion, /AITERM_TURN_NOT_TAKEN/u)
  assert.deepEqual(statuses, ['running', 'failed'])
})

test('終わりまで追った差し込みの画像は、そのターンが終わったら消す', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-image-follow-'))
  let imagePath
  const transport = new AitermTransport({
    tempRoot: root,
    client: { async call(name, args) {
      if (name === 'pty_send') { imagePath = args.image[0]; return steerReceipt() }
      throw new Error(`unexpected ${name}`)
    } },
    handoffContext: noMemory,
    waitProcess: async () => ({ outcome: 'done', steer: { placement: 'same_turn', taken_at: null } }),
  })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'grok', project: '/bots/bot-a' }
  assert.deepEqual(await transport.notify(bot, '画像を見て', { images: [{ mime: 'image/png', data: 'iVBORw0KGgo=' }] }), { delivery: 'steered' })
  await transport.idle(bot.id)
  await assert.rejects(access(imagePath), /ENOENT/u)
})

// Aiterm 0.60.0（ADR 0122）がBellTeamの印の付いたpty_listへ返す形。
function seatTurns(turn) {
  return {
    content: [{ type: 'text', text: 'bot-a\t(agent)' }],
    _meta: { 'aiterm/seat_turns': { schema: 'aiterm.seat-turns.v1', seats: turn === undefined ? [] : [{ session_id: 'bot-a', launch_id: 'launch-a', harness: 'codex-cli', turn }] } },
  }
}

function runningTurn(turnId, cursor = 900) {
  return {
    state: 'running', turn_id: turnId, started_at: '2026-10-13T12:45:27.000Z', event_cursor: cursor, interim_from: `v1:${cursor}:b:${cursor}`,
    wait_process: { executable: '/node', args: ['aiterm-wait', '--session', 'bot-a', '--cursor', String(cursor)] },
  }
}

test('BellTeamが始めていないターンを見つけたら、終わるまで処理中に出し、そのターンの合間の言葉だけを出す', async () => {
  const calls = []
  let finish
  const waiting = new Promise(resolve => { finish = resolve })
  const written = [
    { seq: 1, text: '子の結果を見るね', kind: 'interim', at: '2026-10-13T12:45:30.000Z', turn_id: 'turn-x' },
    { seq: 2, text: '次のターンの言葉', kind: 'interim', at: null, turn_id: 'turn-y' },
    { seq: 3, text: 'まとめるよ', kind: 'interim', at: null, turn_id: null },
  ]
  const transport = new AitermTransport({
    client: { async call(name, args, options) {
      calls.push([name, args, options])
      if (name === 'pty_list') return seatTurns(runningTurn('turn-x'))
      if (name === 'pty_observe')
        return { structuredContent: { state: 'busy' }, ...interimWords(900, written.filter(word => word.seq > options.meta['aiterm/interim_after'])) }
      throw new Error(`unexpected ${name}`)
    } },
    handoffContext: noMemory, interimInterval: 5, activeId: () => 'job-1', waitProcess: async () => waiting,
  })
  const bot = { id: 'bot-a', session: 'bot-a', name: 'リリーバイス', harness: 'codex', project: '/bots/bot-a' }
  const said = []
  const options = { onInterim: (botId, groupId, words) => said.push([botId, groupId, words]), groupId: () => 'g-1' }
  assert.equal(await transport.watchSeatTurns([bot], options), true)
  assert.deepEqual(calls[0], ['pty_list', {}, { meta: { 'aiterm/caller': 'BellTeam' } }])
  const item = {
    id: 'job-1', botId: 'bot-a', botName: 'リリーバイス', status: 'running', startedAt: '2026-10-13T12:45:27.000Z',
    context: 'self', contextId: 'bot-a', groupId: 'g-1', target: 'bot-a',
  }
  assert.deepEqual(transport.queueItems({ botId: bot.id }), [item])
  // 追っている間にもう一度聞いても、同じターンを2つ追わない。
  assert.equal(await transport.watchSeatTurns([bot], options), true)
  assert.deepEqual(transport.queueItems(), [item])
  finish({ outcome: 'done', turn_id: 'turn-x' })
  await transport.idle(bot.id)
  assert.deepEqual(transport.queueItems(), [])
  assert.deepEqual(said.flatMap(([botId, groupId, words]) => words.map(word => [botId, groupId, word])), [
    ['bot-a', 'g-1', { text: '子の結果を見るね', kind: 'interim', at: '2026-10-13T12:45:30.000Z' }],
    ['bot-a', 'g-1', { text: 'まとめるよ', kind: 'interim' }],
  ])
  assert.equal(calls.find(([name]) => name === 'pty_observe')[2].meta['aiterm/interim_from'], 'v1:900:b:900')
  // 回答はThroughlineの側が出す。ここでは読まない。
  assert.equal(calls.some(([name]) => name === 'pty_read'), false)
  // 出した文と追い終えた時刻を覚える。Throughlineの側が、回答の頭に重なる分を外すのに使う。
  const shown = transport.shownInSelfTurn(bot.id)
  assert.deepEqual(shown.words, ['子の結果を見るね', 'まとめるよ'])
  assert.ok(Number.isFinite(shown.endedAt))
  assert.equal(transport.shownInSelfTurn('bot-z'), null)
  // Aitermへ聞いた後に終わったターンを、もう一度追い始めない。
  assert.equal(await transport.watchSeatTurns([bot], options), true)
  assert.deepEqual(transport.queueItems(), [])
})

test('止められたターンは、席の今のターンが替わった時に追うのをやめる', async () => {
  let turn = runningTurn('turn-x')
  let stopped = false
  const transport = new AitermTransport({
    client: { async call(name) {
      if (name === 'pty_list') return seatTurns(turn)
      throw new Error(`unexpected ${name}`)
    } },
    handoffContext: noMemory,
    // 止められたターンでは、Aitermの待ちは返らない。
    waitProcess: (process, signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { stopped = true; reject(new Error('aborted')) })
    }),
  })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'codex', project: '/bots/bot-a' }
  await transport.watchSeatTurns([bot])
  assert.equal(transport.isIdle(bot.id), false)
  // 分からない（記録の末尾を書いている途中）間は、追い続ける。
  turn = null
  await transport.watchSeatTurns([bot])
  assert.equal(transport.isIdle(bot.id), false)
  turn = { state: 'idle' }
  await transport.watchSeatTurns([bot])
  await transport.idle(bot.id)
  assert.equal(stopped, true)
  assert.equal(transport.watches.size, 0)
  // 席が閉じた時も同じ。
  turn = runningTurn('turn-z')
  await transport.watchSeatTurns([bot])
  assert.equal(transport.isIdle(bot.id), false)
  turn = undefined
  await transport.watchSeatTurns([bot])
  await transport.idle(bot.id)
  assert.equal(transport.watches.size, 0)
})

test('エラーで終わった見つけたターンは、Aitermが返した理由を合間の言葉として出す', async () => {
  const transport = new AitermTransport({
    client: { async call(name) {
      if (name === 'pty_list') return seatTurns(runningTurn('turn-x'))
      if (name === 'pty_observe') return { structuredContent: { state: 'busy' }, ...interimWords(900, []) }
      throw new Error(`unexpected ${name}`)
    } },
    handoffContext: noMemory, interimInterval: 5,
    waitProcess: async () => ({ outcome: 'error', error: 'stream disconnected' }),
  })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'codex', project: '/bots/bot-a' }
  const said = []
  await transport.watchSeatTurns([bot], { onInterim: (botId, groupId, words) => said.push(...words) })
  await transport.idle(bot.id)
  assert.deepEqual(said, [{ text: 'AITERM_TURN_ERROR: stream disconnected', kind: 'error' }])
  // エラーの知らせは回答の文ではないので、出した文には数えない。
  assert.deepEqual(transport.shownInSelfTurn(bot.id).words, [])
})

test('配送中の席のターンは追わず、席の今のターンを返さないAitermでは何もしない', async () => {
  let listed = seatTurns(runningTurn('turn-x'))
  const transport = new AitermTransport({
    client: { async call(name) {
      if (name === 'pty_list') return listed
      throw new Error(`unexpected ${name}`)
    } },
    handoffContext: noMemory, waitProcess: async () => { throw new Error('追わない') },
  })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'codex', project: '/bots/bot-a' }
  transport.active.set('job', { bot, info: {} })
  assert.equal(await transport.watchSeatTurns([bot]), true)
  assert.equal(transport.watches.size, 0)
  transport.active.clear()
  // Aiterm 0.59.1までは、印を付けても結果に何も足さない。
  listed = { content: [{ type: 'text', text: 'bot-a\t(agent)' }] }
  assert.equal(await transport.watchSeatTurns([bot]), false)
  assert.equal(transport.watches.size, 0)
  listed = { _meta: { 'aiterm/seat_turns': { schema: 'aiterm.seat-turns.v1', error: 'ENOENT' } } }
  await assert.rejects(transport.watchSeatTurns([bot]), /AITERM_SEAT_TURNS_INVALID: ENOENT/u)
})

test('見つけたターンを追っている席への差し込みは、その見張りに合間の言葉を任せる', async () => {
  let finishTurn
  const turnDone = new Promise(resolve => { finishTurn = resolve })
  const observes = []
  const transport = new AitermTransport({
    client: { async call(name, args, options) {
      if (name === 'pty_list') return seatTurns(runningTurn('turn-x'))
      if (name === 'pty_send') return steerReceipt({ cursor: 950 })
      if (name === 'pty_observe') { observes.push(options.meta['aiterm/interim_from']); return { structuredContent: { state: 'busy' }, ...interimWords(900, []) } }
      throw new Error(`unexpected ${name}`)
    } },
    handoffContext: noMemory, interimInterval: 5,
    waitProcess: async process => process.args.includes('--steer')
      ? { outcome: 'done', turn_id: 'turn-x', steer: { placement: 'same_turn', taken_at: null } } : turnDone,
  })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'codex', project: '/bots/bot-a' }
  await transport.watchSeatTurns([bot])
  const statuses = []
  const steer = transport.turn(bot, '頼む。完成させてくれ。', { onStatus: status => statuses.push(status), onInterim: () => {} })
  assert.deepEqual(await steer.accepted, { delivery: 'steered' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(statuses, ['running'])
  finishTurn({ outcome: 'done', turn_id: 'turn-x' })
  assert.deepEqual(await steer, { delivery: 'steered' })
  await transport.idle(bot.id)
  assert.deepEqual(statuses, ['running', 'delivered'])
  // 差し込みの側は、合間の言葉を読みに行かない。
  assert.deepEqual(observes, [])
})
