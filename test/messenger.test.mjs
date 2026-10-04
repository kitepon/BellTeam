import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MessageAssets } from '../src/message-assets.mjs'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { BellTeamMessenger, userEnvelope } from '../src/messenger.mjs'

test('sendmessageは自然な宛名と本文だけを配達し、識別情報は内部状態へ残す', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-message-'))
  const calls = []
  const transport = {
    async notify(bot, text, options) { calls.push(['notify', bot.id, text, options]); return { delivery: 'running' } },
  }
  const messenger = new BellTeamMessenger({
    bots: new Map([
      ['bell-grok-a', { id: 'bell-grok-a', name: 'あかり', position: '調査主任', role: '調査担当', harness: 'grok', session: 'bell-grok-a', project: '/bots/bell-grok-a' }],
      ['bell-grok-b', { id: 'bell-grok-b', name: 'ゆず', position: '開発主任', role: '開発担当', harness: 'grok', session: 'bell-grok-b', project: '/bots/bell-grok-b' }],
    ]),
    transport,
    logPath: join(root, 'direct.jsonl'),
    onTurnEnd: turn => turns.push(turn),
    now: () => '2026-08-31T00:00:00.000Z',
    deliveryId: () => 'delivery-1',
  })
  const turns = []

  const result = await messenger.sendmessage({ from: 'bell-grok-a', target: 'bell-grok-b', message: '応答してくれ' })

  assert.equal(calls[0][0], 'notify')
  assert.equal(calls[0][1], 'bell-grok-b')
  assert.equal(calls[0][2], '「あかり」からあなたへ次のメッセージが届いています。\n\n応答してくれ')
  assert.doesNotMatch(calls[0][2], /bell-grok-a|delivery-1|調査主任|調査担当/u)
  const { onStatus, onInterim, onAnswer, onTurnEnd, ...options } = calls[0][3]
  onTurnEnd({ startedAt: 's', endedAt: 'e' })
  assert.deepEqual(turns, [{ botId: 'bell-grok-b', context: 'direct', startedAt: 's', endedAt: 'e' }])
  assert.deepEqual(options, {
    images: [],
    queue: {
      context: 'direct', contextId: 'bell-grok-b', groupId: 'delivery-1',
      from: 'bell-grok-a', fromName: 'あかり', target: 'bell-grok-b', message: '応答してくれ',
    },
  })
  assert.equal(typeof onStatus, 'function')
  assert.equal(typeof onInterim, 'function')
  assert.deepEqual(result, {
    delivery: 'running', delivery_id: 'delivery-1', from: 'bell-grok-a', target: 'bell-grok-b',
  })
  await onStatus('running')
  await onAnswer('あかりへ返しておいた')
  await onStatus('delivered')
  const records = (await readFile(join(root, 'direct.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(records[0], {
    schema: 'bellteam.direct-message.v1', delivery_id: 'delivery-1', at: '2026-08-31T00:00:00.000Z',
    from_identity: { id: 'bell-grok-a', name: 'あかり', position: '調査主任', role: '調査担当' },
    target_identity: { id: 'bell-grok-b', name: 'ゆず', position: '開発主任', role: '開発担当' },
    from: 'bell-grok-a', target: 'bell-grok-b', message: '応答してくれ', image: false, delivery: 'running',
  })
  assert.deepEqual(records[2], {
    schema: 'bellteam.interim-word.v1', id: 'delivery-1', at: '2026-08-31T00:00:00.000Z',
    bot: 'bell-grok-b', group_id: 'delivery-1', text: 'あかりへ返しておいた', kind: 'answer',
  })
  assert.deepEqual([records[1], records[3]].map(record => record.delivery), ['running', 'delivered'])
})

test('複数の画像は本文と同じ配達でAIへ渡し、画像本体はログへ残さない', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-image-message-'))
  const bot = { id: 'bell-grok-a', name: 'あかり', role: '調査担当', harness: 'grok', session: 'bell-grok-a', project: '/bots/bell-grok-a' }
  const calls = []
  const messenger = new BellTeamMessenger({
    bots: new Map([[bot.id, bot]]),
    transport: {
      async turn(...args) { calls.push(args); return '青い鳥です' },
    },
    logPath: join(root, 'direct.jsonl'),
    now: () => '2026-08-31T02:00:00.000Z',
    deliveryId: () => 'delivery-image-1',
  })
  const images = [{ mime: 'image/png', data: 'iVBORw0KGgo=' }, { mime: 'image/jpeg', data: '/9j/4A==' }]

  await messenger.userTurn({ target: bot.id, message: 'この画像を見て', images })

  assert.equal(calls.length, 1)
  const [calledBot, envelope, { onStatus, onInterim, ...turnOptions }] = calls[0]
  assert.equal(calledBot, bot)
  assert.equal(envelope, userEnvelope({ id: 'user', name: 'ユーザー', role: 'オーナー' }, 'この画像を見て'))
  assert.equal(typeof onStatus, 'function')
  assert.equal(typeof onInterim, 'function')
  assert.deepEqual(turnOptions, {
    images,
    queue: {
      context: 'direct', contextId: bot.id, groupId: 'delivery-image-1',
      from: 'user', fromName: 'ユーザー', target: bot.id, message: 'この画像を見て',
    },
  })
  const body = await readFile(join(root, 'direct.jsonl'), 'utf8')
  const [record, reply] = body.trim().split('\n').map(JSON.parse)
  assert.equal(record.image, true)
  assert.equal(record.image_count, 2)
  assert.equal(record.message, 'この画像を見て')
  assert.doesNotMatch(body, /iVBORw0KGgo|\/9j\/4A/u)
  assert.equal(reply.message, '青い鳥です')
})

test('Botがuserへ提示する画像を永続化して会話ログから参照する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-present-image-'))
  const source = join(root, 'generated.png')
  await writeFile(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const bot = { id: 'bot-a', name: 'あかり', role: '画像担当', project: join(root, 'bots/bot-a') }
  const messenger = new BellTeamMessenger({
    bots: new Map([[bot.id, bot]]), transport: {}, assets: new MessageAssets({ root }),
    logPath: join(root, 'logs/direct.jsonl'), deliveryId: () => 'delivery-image-1',
  })

  await messenger.sendmessage({ from: bot.id, target: 'user', message: 'できました', image: { path: source } })

  const record = JSON.parse((await readFile(join(root, 'logs/direct.jsonl'), 'utf8')).trim())
  assert.equal(record.image, true)
  assert.deepEqual(record.image_asset, { owner: 'bot-a', file: 'delivery-image-1.png', mime: 'image/png' })
  assert.deepEqual(await readFile(join(root, 'bots/bot-a/messages/assets/delivery-image-1.png')),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
})

test('未定義の宛先と空本文は明示エラーにする', async () => {
  const messenger = new BellTeamMessenger({
    bots: new Map([['bell-grok-a', { id: 'bell-grok-a' }]]),
    transport: {}, logPath: '/unused',
  })
  await assert.rejects(
    messenger.sendmessage({ from: 'bell-grok-a', target: 'missing', message: 'hello' }),
    /BOT_NOT_FOUND: missing/,
  )
  await assert.rejects(
    messenger.sendmessage({ from: 'bell-grok-a', target: 'bell-grok-a', message: '' }),
    /MESSAGE_REQUIRED/,
  )
})

test('ユーザーからBotへはAitermの確定回答を自動で会話へ記録する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-user-message-'))
  const calls = []
  const bot = { id: 'bell-grok-a', name: 'あかり', role: '調査担当', harness: 'grok', session: 'bell-grok-a', project: '/bots/bell-grok-a' }
  const messenger = new BellTeamMessenger({
    bots: new Map([[bot.id, bot]]),
    transport: {
      async turn(target, text) { calls.push(['turn', target.id, text]); return '順調です' },
    },
    logPath: join(root, 'direct.jsonl'),
    onTurnEnd: turn => turns.push(turn),
    now: () => '2026-08-31T01:00:00.000Z',
    deliveryId: () => 'delivery-user-1',
  })
  const turns = []

  await messenger.userTurn({ target: bot.id, message: '進捗を教えて' })

  assert.equal(calls[0][0], 'turn')
  const records = (await readFile(join(root, 'direct.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(records.map(record => record.message), ['進捗を教えて', '順調です'])
  // 返事を記録してから、そのターンの報告漏れを確かめる。
  assert.deepEqual(turns, [{ botId: bot.id, context: 'owner', startedAt: '2026-08-31T01:00:00.000Z', endedAt: '2026-08-31T01:00:00.000Z' }])
})

test('実行中のターンへ差し込んだユーザー送信は、そのターンとして確かめない', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-user-steer-'))
  const bot = { id: 'bot-a', name: 'あかり', role: '調査担当' }
  const turns = []
  const messenger = new BellTeamMessenger({
    bots: new Map([[bot.id, bot]]), transport: { async turn() { return { delivery: 'steered' } } },
    logPath: join(root, 'direct.jsonl'), onTurnEnd: turn => turns.push(turn),
  })
  assert.equal((await messenger.userTurn({ target: bot.id, message: 'ついでにこれも' })).delivery, 'steered')
  assert.deepEqual(turns, [])
})

test('ターン中の合間の言葉は受け取ったBotの会話画面の記録になり、確定回答と取り違えない', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-interim-'))
  const bot = { id: 'bell-grok-a', name: 'あかり', role: '調査担当', harness: 'grok', session: 'bell-grok-a', project: '/bots/bell-grok-a' }
  let id = 0
  const messenger = new BellTeamMessenger({
    bots: new Map([[bot.id, bot]]),
    transport: {
      async turn(target, text, { onInterim }) {
        await onInterim([{ text: 'ちょっと見てくるね', at: '2026-09-28T01:00:03.000Z' }, { text: 'あ、ここ壊れてた' }])
        return '直したよ'
      },
    },
    logPath: join(root, 'direct.jsonl'),
    now: () => '2026-09-28T01:00:05.000Z',
    deliveryId: () => `id-${++id}`,
  })

  const result = await messenger.userTurn({ target: bot.id, message: '見てくれる？' })

  assert.equal(result.reply, '直したよ')
  const records = (await readFile(join(root, 'direct.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(records.filter(record => record.schema === 'bellteam.interim-word.v1'), [
    { schema: 'bellteam.interim-word.v1', id: 'id-2', at: '2026-09-28T01:00:05.000Z', bot: bot.id, group_id: 'id-1', text: 'ちょっと見てくるね', written_at: '2026-09-28T01:00:03.000Z' },
    { schema: 'bellteam.interim-word.v1', id: 'id-3', at: '2026-09-28T01:00:05.000Z', bot: bot.id, group_id: 'id-1', text: 'あ、ここ壊れてた' },
  ])
  assert.deepEqual((await messenger.store.timeline(bot.id)).map(item => [item.kind, item.message]), [
    ['message', '見てくれる？'], ['interim', 'ちょっと見てくるね'], ['interim', 'あ、ここ壊れてた'], ['message', '直したよ'],
  ])
})

test('ユーザー送信はAitermの受理後に返し、確定回答を後から会話へ記録する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-user-queue-'))
  const bot = { id: 'bot-a', name: 'あかり', role: '調査担当' }
  let finish
  const completion = new Promise(resolve => { finish = resolve })
  completion.accepted = Promise.resolve({ delivery: 'running' })
  let replySaved
  const saved = new Promise(resolve => { replySaved = resolve })
  const messenger = new BellTeamMessenger({
    bots: new Map([[bot.id, bot]]),
    transport: { turn() { return completion } },
    logPath: join(root, 'direct.jsonl'),
    onMessage(record) { if (record.message === '確認しました') replySaved() },
    deliveryId: (() => { let id = 0; return () => `delivery-${++id}` })(),
  })

  const result = await messenger.sendmessage({ from: 'user', target: bot.id, message: '調べて' })
  assert.deepEqual(result, {
    delivery: 'running', delivery_id: 'delivery-1', from: 'user', target: 'bot-a',
  })
  assert.deepEqual((await readFile(join(root, 'direct.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse).map(item => item.message), ['調べて'])

  finish('確認しました')
  await saved
  assert.deepEqual((await readFile(join(root, 'direct.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse).map(item => item.message), ['調べて', '確認しました'])
})

test('ユーザーが連続送信しても各ターンの確定回答を欠落させない', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-user-consecutive-'))
  const bot = { id: 'bot-a', name: 'あかり', role: '調査担当' }
  const finishes = []
  let firstSaved, secondSaved
  const firstReply = new Promise(resolve => { firstSaved = resolve })
  const secondReply = new Promise(resolve => { secondSaved = resolve })
  const messenger = new BellTeamMessenger({
    bots: new Map([[bot.id, bot]]),
    transport: {
      turn() {
        const completion = new Promise(resolve => finishes.push(resolve))
        completion.accepted = Promise.resolve({ delivery: 'running' })
        return completion
      },
    },
    logPath: join(root, 'direct.jsonl'),
    onMessage(record) {
      if (record.message === '一件目への回答') firstSaved()
      if (record.message === '二件目への回答') secondSaved()
    },
    deliveryId: (() => { let id = 0; return () => `delivery-${++id}` })(),
  })

  await messenger.sendmessage({ from: 'user', target: bot.id, message: '一件目' })
  await messenger.sendmessage({ from: 'user', target: bot.id, message: '二件目' })
  finishes[0]('一件目への回答')
  await firstReply
  finishes[1]('二件目への回答')
  await secondReply

  const records = (await readFile(join(root, 'direct.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(records.map(record => record.message), [
    '一件目', '二件目', '一件目への回答', '二件目への回答',
  ])
})

test('処理中のBotへ二通目を送るとBellTeamで待たずAitermが差し込み、一つの回答になる', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-user-steer-'))
  const bot = { id: 'bot-a', name: 'あかり', role: '調査担当', session: 'bot-a', harness: 'claude', project: root }
  const sends = []
  let finish
  const waiting = new Promise(resolve => { finish = resolve })
  const transport = new AitermTransport({
    client: { async call(name, args) {
      if (name === 'pty_send') {
        sends.push(args.text)
        return { structuredContent: sends.length === 1
          ? { mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: '/node', args: ['wait'] } }
          : { mode: 'agent_steer', event_cursor: null, wait_process: null } }
      }
      if (name === 'pty_read') return { structuredContent: {
        schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: '両方確認しました',
      } }
      if (name === 'pty_observe') return {}
      throw new Error(`unexpected ${name}`)
    } },
    handoffContext: async () => '', waitProcess: async () => waiting,
  })
  let replySaved
  const saved = new Promise(resolve => { replySaved = resolve })
  const messenger = new BellTeamMessenger({
    bots: new Map([[bot.id, bot]]), transport, logPath: join(root, 'direct.jsonl'),
    onMessage(record) { if (record.message === '両方確認しました') replySaved() },
  })
  const first = await messenger.enqueueUserTurn({ target: bot.id, message: '一件目' })
  const second = await messenger.enqueueUserTurn({ target: bot.id, message: '二件目' })
  assert.equal(first.delivery, 'running')
  assert.equal(second.delivery, 'steered')
  assert.equal(sends.length, 2)
  assert.deepEqual(transport.queueItems({ botId: bot.id }).map(item => item.status), ['running', 'running'])
  finish({ outcome: 'done' })
  await transport.idle(bot.id)
  await saved
  const records = (await readFile(join(root, 'direct.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(records.filter(item => item.schema === 'bellteam.direct-message.v1').map(item => item.message),
    ['一件目', '二件目', '両方確認しました'])
  assert.deepEqual(records.filter(item => item.schema === 'bellteam.delivery-status.v1' && item.delivery === 'delivered').length, 2)
})

test('Botから予約ユーザーへの返答はログへ記録しtmuxへは送らない', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-user-reply-'))
  const calls = []
  const messenger = new BellTeamMessenger({
    bots: new Map([['bell-grok-a', { id: 'bell-grok-a', name: 'あかり', role: '調査担当' }]]),
    transport: {
      async notify() { calls.push('notify') },
    },
    logPath: join(root, 'direct.jsonl'),
    now: () => '2026-08-31T01:01:00.000Z',
    deliveryId: () => 'delivery-user-2',
  })

  const result = await messenger.sendmessage({ from: 'bell-grok-a', target: 'user', message: '順調です' })

  assert.deepEqual(calls, [])
  assert.equal(result.target, 'user')
  const record = JSON.parse((await readFile(join(root, 'direct.jsonl'), 'utf8')).trim())
  assert.equal(record.message, '順調です')
  assert.equal(record.delivery, 'delivered')
})

test('通常ターン中にBotがuserへ明示送信しても自動回答を重ねない', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-user-dedup-'))
  const bot = { id: 'bell-grok-a', name: 'あかり', role: '調査担当' }
  let messenger
  messenger = new BellTeamMessenger({
    bots: new Map([[bot.id, bot]]),
    transport: {
      async turn() {
        await messenger.sendmessage({ from: bot.id, target: 'user', message: 'こんばんは。' })
        return '内部前置き\nこんばんは。\n[agent_transcript vendor=grok]'
      },
    },
    logPath: join(root, 'direct.jsonl'),
    now: () => '2026-08-31T14:30:00.000Z',
    deliveryId: (() => { let id = 0; return () => `delivery-${++id}` })(),
  })

  const result = await messenger.userTurn({ target: bot.id, message: 'こんばんは' })

  const records = (await readFile(join(root, 'direct.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(records.map(record => record.message), ['こんばんは', 'こんばんは。'])
  assert.equal(result.reply, 'こんばんは。')
  assert.equal(result.reply_id, 'delivery-2')
})

test('オーナーが送った画像を全部オーナーの場所へ残し、会話ログから参照する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-owner-image-'))
  const bot = { id: 'bot-a', name: 'あかり', role: '調査担当', project: join(root, 'bots/bot-a') }
  const messenger = new BellTeamMessenger({
    bots: new Map([[bot.id, bot]]), transport: { async turn() { return '見ました' } }, assets: new MessageAssets({ root }),
    logPath: join(root, 'logs/direct.jsonl'), deliveryId: () => 'delivery-owner-1',
  })
  const images = [{ mime: 'image/png', data: 'iVBORw0KGgo=' }, { mime: 'image/jpeg', data: '/9j/4A==' }]

  await messenger.userTurn({ target: bot.id, message: '2枚送るね', images })

  const [record] = (await readFile(join(root, 'logs/direct.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(record.image_count, 2)
  assert.deepEqual(record.image_assets, [
    { owner: 'user', file: 'delivery-owner-1-1.png', mime: 'image/png' },
    { owner: 'user', file: 'delivery-owner-1-2.jpg', mime: 'image/jpeg' },
  ])
  assert.deepEqual(await readFile(join(root, 'owner/messages/assets/delivery-owner-1-2.jpg')), Buffer.from('/9j/4A==', 'base64'))
  const [item] = await messenger.store.timeline(bot.id)
  assert.equal(item.image_count, 2)
  assert.equal(item.imageAssets.length, 2)
})
