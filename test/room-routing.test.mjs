import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { chooseRoomResponder, roomTurnsFromThroughline } from '../src/room-routing.mjs'

test('Jevへの一回の要求に継続判断と仮の返信者選択を同梱する', async () => {
  const calls = []
  const room = { name: '製品改良', purpose: '担当製品を全OSで維持する' }
  const members = [
    { id: 'bot-a', name: 'あかり', position: '調査主任', role: '調査' },
    { id: 'bot-b', name: 'ゆず', position: '開発主任', role: '開発' },
  ]
  const fetcher = async (url, options) => {
    calls.push([url, options])
    return new Response(JSON.stringify({ answers: {
      continue: { type: 'noul', noul: 0.88 },
      responder: { type: 'choice', choice: 'bot-b' },
    } }), { status: 200 })
  }
  const turns = [
    { speaker: 'あかり', text: '調査します' },
    { speaker: 'ゆず', text: '調査できました' },
    { speaker: 'クオ', text: '実装を頼む' },
  ]
  assert.deepEqual(await chooseRoomResponder({ room, turns, members, fetcher, apiKey: '試験用' }), ['bot-b'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'https://api.typesafe.ai/v1/systemone')
  const request = JSON.parse(calls[0][1].body)
  assert.deepEqual(request.state.room, room)
  assert.deepEqual(request.state.current, turns.at(-1))
  assert.deepEqual(request.state.preceding, turns.slice(0, -1))
  assert.deepEqual(request.state.members, members)
  assert.deepEqual(Object.keys(request.questions), ['continue', 'responder'])
  assert.match(request.questions.continue.instructions, /直近3ターンの会話に対して.*次の発言が必要か/u)
  assert.match(request.questions.continue.criteria.true, /呼びかけや挨拶/u)
  assert.match(request.questions.continue.criteria.false, /お礼/u)
  assert.match(request.questions.responder.instructions, /直近3ターンの会話に対して、次に発言するべき/u)
  assert.equal(request.questions.responder.instructions, '直近3ターンの会話に対して、次に発言するべき部屋のメンバーは誰か。')
  assert.doesNotMatch(JSON.stringify(request.questions), /最後の発言/u)
  assert.deepEqual(Object.keys(request.questions.responder.criteria), ['bot-a', 'bot-b'])
  assert.equal(request.questions.responder.criteria['bot-a'], '名前: あかり\n役職: 調査主任\n役割: 調査')
})

test('継続不要なら同じ応答内の返信者を使わない', async () => {
  const fetcher = async () => new Response(JSON.stringify({ answers: {
    continue: { type: 'noul', noul: 0.12 },
    responder: { type: 'choice', choice: 'bot-a' },
  } }), { status: 200 })
  assert.deepEqual(await chooseRoomResponder({
    room: { name: '開発室', purpose: '仕事の共有' },
    turns: [{ speaker: 'クオ', text: 'ありがとう' }],
    members: [{ id: 'bot-a', name: 'あかり', role: '' }], fetcher, apiKey: '試験用',
  }), [])
})

test('継続確率0.57は返信せず、0.6から返信する', async () => {
  const members = [{ id: 'bot-a', name: 'あかり', role: '担当' }]
  const turns = [{ speaker: 'あかり', text: '受けます。担当の意見は参考にします。' }]
  const fetcher = score => async () => new Response(JSON.stringify({ answers: {
    continue: { type: 'noul', noul: score },
    responder: { type: 'choice', choice: 'bot-a' },
  } }), { status: 200 })
  const room = { name: '開発室', purpose: '仕事の共有' }
  assert.deepEqual(await chooseRoomResponder({ room, turns, members, fetcher: fetcher(0.57), apiKey: '試験用' }), [])
  assert.deepEqual(await chooseRoomResponder({ room, turns, members, fetcher: fetcher(0.6), apiKey: '試験用' }), ['bot-a'])
})

test('Throughlineの公開結果は現在の発言で終わる3ターンだけを渡す', async () => {
  let input = ''
  const launch = () => {
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin.on('data', chunk => { input += chunk })
    queueMicrotask(() => {
      child.stdout.end(JSON.stringify({
        schema: 'throughline.room_context.v1', status: 'ready',
        turns: [
          { messageId: 'before', speaker: 'あかり', text: '確認した' },
          { messageId: 'now', speaker: 'クオ', text: '次は？' },
        ],
      }))
      child.emit('close', 0)
    })
    return child
  }
  const turns = await roomTurnsFromThroughline({
    projectPath: '/srv/bellteam/rooms', roomId: 'room-a', messageId: 'now',
    speaker: 'クオ', text: '次は？', launch,
  })
  assert.deepEqual(turns, [
    { speaker: 'あかり', text: '確認した' }, { speaker: 'クオ', text: '次は？' },
  ])
  assert.equal(JSON.parse(input).messageId, 'now')
})
