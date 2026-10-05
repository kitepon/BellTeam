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
    ['agent_launch', { harness: 'codex-cli', cwd: project, session_name: 'bot-a', trust_project: true }],
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
  assert.deepEqual(launches, [{ harness: 'claude-code', cwd: project, session_name: 'bot-a', trust_project: true }])
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
    ['agent_launch', { harness: 'grok-cli', cwd: project, session_name: 'bot-a', trust_project: true }],
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
