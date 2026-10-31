import assert from 'node:assert/strict'
import { once } from 'node:events'
import { appendFile, mkdtemp, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ConversationStore } from '../src/conversation-store.mjs'
import { RoomRegistry } from '../src/room-registry.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'

const line = value => JSON.stringify(value) + '\n'
const direct = (id, bot, at = '2026-10-22T00:00:00Z') => ({
  schema: 'bellteam.direct-message.v1', delivery_id: id, from: 'user', target: bot,
  message: `text-${id}`, delivery: 'running', at,
})

test('一覧相当の全Bot読取は無関係な履歴をBot数だけ走査しない', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bell-history-fanout-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'direct.jsonl')
  const records = Array.from({ length: 1200 }, (_, i) => direct(`m${i}`, `bot-${i % 30}`))
  await writeFile(path, records.map(line).join(''))
  const store = new ConversationStore({ logPath: path })
  const parse = JSON.parse
  let sourceReads = 0
  JSON.parse = (...args) => {
    const record = parse(...args)
    return record?.schema === 'bellteam.direct-message.v1' ? new Proxy(record, {
      get(target, key, receiver) {
        if (key === 'from') sourceReads++
        return Reflect.get(target, key, receiver)
      },
    }) : record
  }
  try {
    const histories = await Promise.all(Array.from({ length: 30 }, (_, i) => store.timeline(`bot-${i}`)))
    for (let i = 0; i < histories.length; i++) {
      assert.equal(histories[i].length, 40)
      assert.deepEqual(histories[i].map(x => x.id), records.filter(x => x.target === `bot-${i}`).map(x => x.delivery_id))
    }
    assert.ok(sourceReads < records.length * 10, `unrelated-history reads: ${sourceReads}`)
  } finally { JSON.parse = parse }
})

test('ルームの再読取は追記だけをparseし、過去行の状態変更と古い応答を両立する', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bell-room-append-perf-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const rooms = new RoomRegistry({ roomsRoot: root, bots: new Map(), roomId: () => 'room-a' })
  await rooms.initialize()
  await rooms.create({ name: 'test', memberIds: [] })
  for (let i = 0; i < 120; i++) await rooms.appendMessage('room-a', {
    schema: 'bellteam.room-message.v1', id: `m${i}`, message: 'text', at: String(i),
    deliveries: [{ target: 'bot-a', delivery: 'running' }],
  })
  const first = await rooms.messages('room-a')
  const parse = JSON.parse
  let parses = 0
  JSON.parse = (...args) => { parses++; return parse(...args) }
  try {
    assert.deepEqual(await rooms.messages('room-a'), first)
    assert.equal(parses, 0, 'unchanged history must not be parsed again')
    await rooms.appendMessage('room-a', { schema: 'bellteam.room-delivery-status.v1', message_id: 'm0', target: 'bot-a', delivery: 'delivered' })
    await rooms.appendMessage('room-a', { schema: 'bellteam.room-routing-status.v1', message_id: 'm0', routing: { status: 'ready', responders: [] } })
    const next = await rooms.messages('room-a')
    assert.equal(parses, 2)
    assert.equal(next[0].deliveries[0].delivery, 'delivered')
    assert.equal(next[0].routing.status, 'ready')
    assert.equal(first[0].deliveries[0].delivery, 'running')
  } finally { JSON.parse = parse }
  const path = join(root, 'room-a/messages.jsonl')
  await writeFile(path, line({ id: 'short', message: 'new' }))
  assert.deepEqual((await rooms.messages('room-a')).map(x => x.id), ['short'])
  await writeFile(path + '.replacement', line({ id: 'other', message: 'new' }))
  await rename(path + '.replacement', path)
  assert.deepEqual((await rooms.messages('room-a')).map(x => x.id), ['other'])
  await appendFile(path, JSON.stringify({ id: 'tail', message: 'tail' }))
  assert.deepEqual((await rooms.messages('room-a')).map(x => x.id), ['other', 'tail'])
  await appendFile(path, '\n')
  assert.deepEqual((await rooms.messages('room-a')).map(x => x.id), ['other', 'tail'])
  await appendFile(path, '{broken}\n')
  await assert.rejects(rooms.messages('room-a'), SyntaxError)
  await assert.rejects(rooms.messages('room-a'), SyntaxError)
})

test('過去の配送状態と追記は両Botへ反映し、変更前の応答を書き換えない', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bell-direct-index-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'direct.jsonl')
  await writeFile(path, line({ ...direct('peer', 'bot-b'), from: 'bot-a' }))
  const store = new ConversationStore({ logPath: path })
  const before = await store.timeline('bot-a')
  await store.timeline('bot-b')
  await appendFile(path, line({ schema: 'bellteam.delivery-status.v1', delivery_id: 'peer', delivery: 'failed' }))
  for (const bot of ['bot-a', 'bot-b']) assert.equal((await store.timeline(bot))[0].delivery, 'failed')
  assert.equal(before[0].delivery, 'running')
  await appendFile(path, line({ schema: 'bellteam.interim-word.v1', bot: 'bot-b', id: 'word', text: 'working', at: '2026-10-22T00:00:01Z' }))
  assert.equal((await store.timeline('bot-a')).length, 1)
  assert.equal((await store.timeline('bot-b')).length, 2)
})

test('改行なし末尾を読んだroomログが同inodeで未確定offsetより大きく縮んでも再構築する', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bell-room-tail-shrink-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const rooms = new RoomRegistry({ roomsRoot: root, bots: new Map(), roomId: () => 'room-a' })
  await rooms.initialize()
  await rooms.create({ name: 'test', memberIds: [] })
  const path = join(root, 'room-a/messages.jsonl')
  const prefix = line({ id: 'old', message: 'old' })
  const original = prefix + JSON.stringify({ id: 'tail', message: 'x'.repeat(500) })
  const replacement = line({ id: 'new', message: 'y'.repeat(75) })
  assert.ok(Buffer.byteLength(prefix) < Buffer.byteLength(replacement))
  assert.ok(Buffer.byteLength(replacement) < Buffer.byteLength(original))
  await writeFile(path, original)
  const oldInode = (await stat(path)).ino
  const before = await rooms.messages('room-a')
  assert.deepEqual(before.map(x => x.id), ['old', 'tail'])
  // Also preserve the documented same-size rewrite recovery with a tail.
  const sameSize = line({ id: 'alt', message: 'old' }) + JSON.stringify({ id: 'tail', message: 'z'.repeat(500) })
  assert.equal(Buffer.byteLength(sameSize), Buffer.byteLength(original))
  await writeFile(path, sameSize)
  await utimes(path, new Date(), new Date(Date.now() + 2000))
  assert.deepEqual((await rooms.messages('room-a')).map(x => x.id), ['alt', 'tail'])
  await writeFile(path, replacement)
  assert.equal((await stat(path)).ino, oldInode)
  for (let i = 0; i < 2; i++) assert.deepEqual((await rooms.messages('room-a')).map(x => x.id), ['new'])
  assert.deepEqual(before.map(x => x.id), ['old', 'tail'])
  await appendFile(path, line({ id: 'next', message: 'next' }))
  assert.deepEqual((await rooms.messages('room-a')).map(x => x.id), ['new', 'next'])
})

test('直接会話も改行なし末尾後の同inode縮小で旧Bot索引と配送状態を破棄する', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bell-direct-tail-shrink-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'direct.jsonl')
  const prefix = line(direct('old', 'bot-a'))
  const original = prefix + JSON.stringify({ ...direct('tail', 'bot-b'), message: 'x'.repeat(500) })
  const replacement = line({ ...direct('new', 'bot-a'), message: 'y'.repeat(75) })
  assert.ok(Buffer.byteLength(prefix) < Buffer.byteLength(replacement))
  assert.ok(Buffer.byteLength(replacement) < Buffer.byteLength(original))
  await writeFile(path, original)
  const oldInode = (await stat(path)).ino
  const store = new ConversationStore({ logPath: path })
  assert.deepEqual((await store.timeline('bot-a')).map(x => x.id), ['old'])
  assert.deepEqual((await store.timeline('bot-b')).map(x => x.id), ['tail'])
  const sameSize = line(direct('alt', 'bot-a')) + JSON.stringify({ ...direct('tail', 'bot-b'), message: 'z'.repeat(500) })
  assert.equal(Buffer.byteLength(sameSize), Buffer.byteLength(original))
  await writeFile(path, sameSize)
  await utimes(path, new Date(), new Date(Date.now() + 2000))
  assert.deepEqual((await store.timeline('bot-a')).map(x => x.id), ['alt'])
  await writeFile(path, replacement)
  assert.equal((await stat(path)).ino, oldInode)
  for (let i = 0; i < 2; i++) {
    assert.deepEqual((await store.timeline('bot-a')).map(x => x.id), ['new'])
    assert.deepEqual(await store.timeline('bot-b'), [])
  }
  await appendFile(path, line({ schema: 'bellteam.delivery-status.v1', delivery_id: 'new', delivery: 'delivered' }))
  assert.equal((await store.timeline('bot-a'))[0].delivery, 'delivered')
})

test('ページ外の画像を整形せず、before/afterとカード変更の既存応答を保つ', async t => {
  const rows = Array.from({ length: 260 }, (_, i) => ({
    id: `m${i}`, message: `text${i}`, kind: 'message', at: String(i).padStart(4, '0'),
    imageAsset: { owner: 'bot-a', file: `m${i}.png` },
  }))
  let imageReads = 0
  for (const row of rows) {
    const asset = row.imageAsset
    Object.defineProperty(row, 'imageAsset', { enumerable: true, get() { imageReads++; return asset } })
  }
  let card = { id: 'card', kind: 'owner_question', at: '9999', message: 'question', owner_question: { status: 'open' } }
  const rooms = Object.assign(new Map([['room-a', { id: 'room-a' }]]), { async refresh() {}, async messages() { return rows } })
  const server = createBellTeamServer({ bots: new Map([['bot-a', { id: 'bot-a' }]]),
    rooms, authorize: () => true, store: { async timeline() { return rows } },
    ownerQuestions: { timeline() { return [card] } }, writeLog() {},
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const get = async (kind, query) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/${kind}/messages?${query}`)
    assert.equal(response.status, 200)
    return response.json()
  }
  const page = await get('bots/bot-a', 'limit=10')
  assert.equal(page.items.length, 10); assert.equal(page.has_more, true)
  assert.equal(page.remaining_before, 251, 'the owner question is a displayed timeline row')
  assert.equal(page.items.at(-1).id, 'card')
  assert.equal(page.items[0].image_url, '/api/message-images/bot-a/m251.png')
  // webMessage reads the selected asset and object spread also reads it once.
  assert.ok(imageReads <= 30, `off-page image reads: ${imageReads}`)
  card = { ...card, owner_question: { status: 'answered' } }
  assert.equal((await get('bots/bot-a', 'limit=1')).items[0].owner_question.status, 'answered')
  assert.equal((await get('bots/bot-a', 'before=m10&limit=20')).items.length, 10)
  assert.equal((await get('bots/bot-a', 'before=m10&limit=20')).remaining_before, 0)
  assert.equal((await get('bots/bot-a', 'before=m200&limit=20')).remaining_before, 180)
  const after = await get('bots/bot-a', 'after=m0&limit=1')
  assert.equal(after.items.length, 260, 'legacy after returns every subsequent row')
  assert.equal(after.has_more, false)
  assert.equal(Object.hasOwn(after, 'remaining_before'), false)
  assert.equal((await get('rooms/room-a', 'limit=10')).items.length, 10)
  assert.equal((await get('rooms/room-a', 'limit=10')).remaining_before, 250)
  assert.equal((await get('rooms/room-a', 'before=m15&limit=5')).remaining_before, 10)
  assert.equal((await get('rooms/room-a', 'before=m0')).remaining_before, 0)
  assert.equal((await get('rooms/room-a', 'before=missing')).remaining_before, 250)
})
