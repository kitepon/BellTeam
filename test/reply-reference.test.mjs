import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { validateConversationRequest } from '../src/conversation/requests.mjs'
import { validateDirectLogRecord } from '../src/direct-log-record.mjs'
import { BellTeamMessenger } from '../src/messenger.mjs'
import { QUOTE_MAX, locateQuote, replyNotice, snapshotReply, validReplyQuote, validReplyTo } from '../src/reply-reference.mjs'
import { RoomHistory } from '../src/room-history.mjs'
import { RoomMessenger, roomEnvelope } from '../src/room-messenger.mjs'

const source = { sender: { id: 'bot-a', name: 'あかり' }, at: '2026-11-16T12:20:00.000Z', text: '一行目\n二行目', image: false }

test('snapshotReply cuts at 300 code points and replyNotice reads from the snapshot only', () => {
  const long = snapshotReply('m1', { ...source, text: '😀'.repeat(QUOTE_MAX + 1) })
  assert.equal([...long.text].length, QUOTE_MAX)
  assert.equal(long.truncated, true)
  assert.equal(snapshotReply('m1', { ...source, text: 'a'.repeat(QUOTE_MAX) }).truncated, undefined)
  assert.deepEqual(snapshotReply('m9', null), { id: 'm9', available: false })
  assert.equal(replyNotice(snapshotReply('m1', source)),
    'これは次の発言への返信です。\n返信先: 「あかり」 2026-11-16 21:20 JST（メッセージID: m1）\n> 一行目\n> 二行目\n\n')
  assert.match(replyNotice(snapshotReply('m1', { ...source, text: '', image: true })), /> （画像）/u)
  assert.match(replyNotice({ id: 'm9', available: false }), /元の発言は見つかりませんでした（メッセージID: m9）/u)
  assert.equal(replyNotice(null), '')
  assert.ok(validReplyTo('x') && !validReplyTo('') && !validReplyTo(1) && !validReplyTo('a\0') && !validReplyTo('a'.repeat(201)))
})

test('direct: the Owner replies to an Owner row, a Bot row and an interim row; unusable ids stay unavailable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reply-direct-')); t.after(() => rm(root, { recursive: true, force: true }))
  const bots = new Map([['bot-a', { id: 'bot-a', name: 'あかり' }], ['bot-b', { id: 'bot-b', name: 'ゆず' }]])
  const sent = []
  let answer = '承知しました', n = 0
  const messenger = new BellTeamMessenger({ bots, logPath: join(root, 'direct.jsonl'), deliveryId: () => `id-${++n}`,
    now: () => '2026-11-16T12:20:00.000Z',
    transport: { async notify() { return { delivery: 'running' } }, async turn(bot, text, options) { sent.push(text); await options.onInterim?.([{ text: '調べています' }]); return answer } } })
  const send = async input => { const turn = messenger.userTurn({ target: 'bot-a', ...input }); await turn; return turn }

  await send({ message: '最初の話題' })                    // id-1 owner row, interim id-2, answer id-3
  const owner = 'id-1', interim = 'id-2', bot = 'id-3'
  await send({ message: 'それは違います', replyTo: owner })
  await send({ message: 'ありがとう', replyTo: bot })
  await send({ message: '途中の言葉へ', replyTo: interim })
  await send({ message: '知らない', replyTo: 'nope' })
  await messenger.sendmessage({ from: 'bot-b', target: 'bot-a', message: 'ひそひそ' })
  await send({ message: '他の会話', replyTo: 'id-' + (n) })   // a Bot-to-Bot row of the same Bot: not quotable

  const rows = (await readFile(join(root, 'direct.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const replies = rows.filter(row => row.schema === 'bellteam.direct-message.v1' && row.reply_to)
  rows.forEach(validateDirectLogRecord)
  assert.deepEqual(replies.map(row => [row.message, row.reply_to.available, row.reply_to.text ?? null]), [
    ['それは違います', true, '最初の話題'], ['ありがとう', true, '承知しました'], ['途中の言葉へ', true, '調べています'],
    ['知らない', false, null], ['他の会話', false, null]])
  assert.deepEqual(replies[0].reply_to.sender, { id: 'user', name: 'ユーザー' })
  assert.equal(replies[1].reply_to.sender.id, 'bot-a')
  assert.equal(replies[2].reply_to.sender.name, 'あかり')
  assert.match(sent[1], /^「オーナー」からあなたへ次のメッセージが届いています。\n\nこれは次の発言への返信です。\n返信先: 「オーナー」 2026-11-16 21:20 JST（メッセージID: id-1）\n> 最初の話題\n\nそれは違います$/u)
  assert.match(sent[4], /元の発言は見つかりませんでした（メッセージID: nope）/u)
  assert.doesNotMatch(sent[0], /返信/u)
  // history item carries the saved snapshot; rows without reply_to stay as they were
  const items = await messenger.store.timeline('bot-a')
  assert.deepEqual(items.find(item => item.message === 'それは違います').reply_to, replies[0].reply_to)
  assert.equal(Object.hasOwn(items.find(item => item.message === '最初の話題'), 'reply_to'), false)
})

test('direct: a malformed reply_to is refused before anything is saved', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reply-invalid-')); t.after(() => rm(root, { recursive: true, force: true }))
  const messenger = new BellTeamMessenger({ bots: new Map([['bot-a', { id: 'bot-a', name: 'あかり' }]]),
    logPath: join(root, 'direct.jsonl'), transport: { async turn() { throw new Error('not reached') } } })
  for (const replyTo of ['', 7, 'a'.repeat(201)])
    await assert.rejects(messenger.userTurn({ target: 'bot-a', message: 'x', replyTo }), { code: 'REPLY_TO_INVALID' })
  await assert.rejects(readFile(join(root, 'direct.jsonl')), { code: 'ENOENT' })
})

test('room: reply to a room message; another room, unknown id and Bot posts do not leak or post a reply', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reply-room-')); t.after(() => rm(root, { recursive: true, force: true }))
  const bots = new Map([['bot-a', { id: 'bot-a', name: 'あかり' }]])
  const room = { id: 'room-a', name: '相談', purpose: '共有', memberIds: ['bot-a'] }
  const rooms = new Map([[room.id, room]]), records = []
  const history = new RoomHistory(join(root, 'messages.jsonl'))
  rooms.appendMessage = async (_id, record) => { records.push(record); await writeFile(join(root, 'messages.jsonl'), records.map(r => `${JSON.stringify(r)}\n`).join('')) }
  rooms.messages = async () => records
  rooms.quoteSource = (roomId, id) => roomId === room.id ? history.quoteSource(id) : Promise.reject(new Error('other'))
  const notified = []
  const messenger = new RoomMessenger({ rooms, bots, roomTurns: async () => [], chooseResponder: async () => ['bot-a'],
    transport: { async notify(_bot, text) { notified.push(text); return { delivery: 'running' } } } })
  const first = await messenger.sendroommessage({ from: 'user', room: room.id, message: '最初の議題' })
  await messenger.sendroommessage({ from: 'user', room: room.id, message: 'その件ですが', replyTo: first.id })
  await messenger.sendroommessage({ from: 'user', room: room.id, message: '迷子', replyTo: 'no-such' })
  const [, quoted, lost] = records.filter(record => record.schema === 'bellteam.room-message.v1')
  assert.equal(quoted.reply_to.available, true)
  assert.deepEqual([quoted.reply_to.id, quoted.reply_to.text, quoted.reply_to.sender.id], [first.id, '最初の議題', 'user'])
  assert.deepEqual(lost.reply_to, { id: 'no-such', available: false })
  assert.match(notified[1], new RegExp(`「オーナー」からあなたへ次のメッセージが届いています。\\n\\nこれは次の発言への返信です。\\n返信先: 「オーナー」 .*メッセージID: ${first.id}）\\n> 最初の議題\\n\\nその件ですが`, 'u'))
  assert.match(roomEnvelope({ ...quoted, room: { ...quoted.room, members: [] } }, { silent: true }), /respond_to_room\(action="silent"/u)
  await assert.rejects(messenger.sendroommessage({ from: 'bot-a', room: room.id, message: 'x', replyTo: first.id }), { message: 'REPLY_TO_NOT_ALLOWED' })
  await assert.rejects(messenger.sendroommessage({ from: 'user', room: room.id, message: 'x', replyTo: '' }), { code: 'REPLY_TO_INVALID' })
  assert.equal(records.filter(record => record.schema === 'bellteam.room-message.v1').length, 3)
})

test('selected part: located by hint, then first occurrence; cut text keeps the whole range; unfound keeps the text', () => {
  const original = { ...source, text: '😀はい。いいえ。はい。' }
  assert.deepEqual(locateQuote(original.text, { text: 'はい。' }), { start: 1, end: 4 })
  assert.deepEqual(locateQuote(original.text, { text: 'はい。', start: 8 }), { start: 8, end: 11 })
  assert.deepEqual(locateQuote(original.text, { text: 'はい。', start: 2 }), { start: 1, end: 4 })
  assert.equal(locateQuote(original.text, { text: '無い' }), null)
  assert.deepEqual(snapshotReply('m1', original, { text: 'はい。', start: 8 }),
    { id: 'm1', available: true, sender: { id: 'bot-a', name: 'あかり' }, at: source.at, text: 'はい。', part: true, range: { start: 8, end: 11 } })
  assert.deepEqual(snapshotReply('m1', original, { text: '無い' }).range, undefined)
  assert.equal(snapshotReply('m1', original, { text: '無い' }).part, true)
  const big = '😀'.repeat(QUOTE_MAX + 5), cut = snapshotReply('m1', { ...source, text: big }, { text: big })
  assert.deepEqual([[...cut.text].length, cut.truncated, cut.range], [QUOTE_MAX, true, { start: 0, end: QUOTE_MAX + 5 }])
  assert.deepEqual(snapshotReply('m9', null, { text: 'はい。' }), { id: 'm9', available: false, part: true, text: 'はい。' })
  assert.equal(replyNotice(snapshotReply('m1', original, { text: 'はい。' })),
    'これは次の発言の一部への返信です。\n返信先: 「あかり」 2026-11-16 21:20 JST（メッセージID: m1）\n引用した部分:\n> はい。\n\n')
  assert.match(replyNotice({ id: 'm9', available: false, part: true, text: 'はい。' }), /一部への返信ですが、元の発言は見つかりませんでした（メッセージID: m9）。\n引用した部分（選択された文章そのまま）:\n> はい。/u)
  assert.ok(validReplyQuote({ text: 'a', start: 0 }) && validReplyQuote({ text: 'a' }))
  for (const bad of [null, 'a', { text: '' }, { text: '  ' }, { text: 'a', start: -1 }, { text: 'a', start: 1.5 }, { text: 'a', extra: 1 }, { text: 'a'.repeat(10001) }])
    assert.equal(validReplyQuote(bad), false)
})

test('selected part through the Messenger: saved with range, delivered with the part, malformed quote refused', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reply-part-')); t.after(() => rm(root, { recursive: true, force: true }))
  const bots = new Map([['bot-a', { id: 'bot-a', name: 'あかり' }]])
  const sent = []
  let n = 0
  const messenger = new BellTeamMessenger({ bots, logPath: join(root, 'direct.jsonl'), deliveryId: () => `id-${++n}`,
    now: () => '2026-11-16T12:20:00.000Z', transport: { async turn(_bot, text) { sent.push(text); return '了解です' } } })
  await messenger.userTurn({ target: 'bot-a', message: 'AはBです。CはDです。' })
  await messenger.userTurn({ target: 'bot-a', message: 'そこだけ違う', replyTo: 'id-1', replyQuote: { text: 'CはDです。' } })
  await messenger.userTurn({ target: 'bot-a', message: '迷子の一部', replyTo: 'nope', replyQuote: { text: 'XYZ' } })
  for (const replyQuote of [{ text: '' }, 'x']) await assert.rejects(messenger.userTurn({ target: 'bot-a', message: 'x', replyTo: 'id-1', replyQuote }), { code: 'REPLY_QUOTE_INVALID' })
  await assert.rejects(messenger.userTurn({ target: 'bot-a', message: 'x', replyQuote: { text: 'a' } }), { code: 'REPLY_QUOTE_INVALID' })
  const rows = (await readFile(join(root, 'direct.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  rows.forEach(validateDirectLogRecord)
  const [part, lost] = rows.filter(row => row.reply_to)
  assert.deepEqual([part.reply_to.text, part.reply_to.part, part.reply_to.range, part.reply_to.available], ['CはDです。', true, { start: 6, end: 12 }, true])
  assert.deepEqual(lost.reply_to, { id: 'nope', available: false, part: true, text: 'XYZ' })
  assert.match(sent[1], /一部への返信です。\n返信先: 「オーナー」.*\n引用した部分:\n> CはDです。\n\nそこだけ違う$/u)
  assert.equal(rows.filter(row => row.schema === 'bellteam.direct-message.v1' && row.from === 'user').length, 3)
})

test('the module request validators carry reply fields for the Owner and refuse malformed ones', () => {
  const context = { generation: 'g1', operationId: 'o1', continuation: false, actor: { kind: 'owner' } }
  const post = extra => ({ target: 'bot-a', message: 'x', images: [], ...extra })
  validateConversationRequest('user.post', post({ replyTo: 'm1', replyQuote: { text: 'a', start: 0 } }), context)
  validateConversationRequest('room.post', { from: 'user', room: 'room-a', message: 'x', images: [], replyTo: 'm1' }, context)
  for (const bad of [{ replyTo: '' }, { replyQuote: { text: ' ' } }, { replyQuote: { text: 'a', start: -1 } }])
    assert.throws(() => validateConversationRequest('user.post', post(bad), context), { code: 'CONVERSATION_REQUEST_INVALID' })
})
