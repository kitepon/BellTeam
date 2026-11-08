import assert from 'node:assert/strict'
import { appendFile, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ConversationStore } from '../src/conversation-store.mjs'

test('個別タイムラインはユーザー会話を吹き出し、Bot間通信を折りたたみ活動行にする', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-conversation-'))
  const logPath = join(root, 'direct.jsonl')
  const records = [
    { schema: 'bellteam.direct-message.v1', delivery_id: '1', at: '2026-08-31T01:00:00.000Z', from: 'user', target: 'bell-grok-a', message: '調べて', image: true, delivery: 'queued' },
    { schema: 'bellteam.delivery-status.v1', delivery_id: '1', at: '2026-08-31T01:00:01.000Z', delivery: 'running' },
    { schema: 'bellteam.delivery-status.v1', delivery_id: '1', at: '2026-08-31T01:00:02.000Z', delivery: 'failed' },
    { schema: 'bellteam.direct-message.v1', delivery_id: '2', at: '2026-08-31T01:01:00.000Z', from: 'bell-grok-a', target: 'bell-grok-b', target_identity: { id: 'bell-grok-b', name: 'ゆず', position: '開発主任', role: '開発' }, message: '仕様を確認して', delivery: 'delivered' },
    { schema: 'bellteam.direct-message.v1', delivery_id: '3', at: '2026-08-31T01:02:00.000Z', from: 'bell-grok-b', target: 'bell-grok-a', from_identity: { id: 'bell-grok-b', name: 'ゆず', position: '開発主任', role: '開発' }, message: '確認できた', delivery: 'delivered' },
    { schema: 'bellteam.direct-message.v1', delivery_id: '4', at: '2026-08-31T01:03:00.000Z', from: 'bell-grok-a', target: 'user', message: '確認できました', delivery: 'delivered' },
    { schema: 'bellteam.direct-message.v1', delivery_id: '5', at: '2026-08-31T01:04:00.000Z', from: 'bell-grok-b', target: 'user', message: '関係ない会話', delivery: 'delivered' },
  ]
  await writeFile(logPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`)

  const timeline = await new ConversationStore({ logPath }).timeline('bell-grok-a')

  assert.deepEqual(timeline.map(item => [item.kind, item.direction, item.message]), [
    ['message', 'outgoing', '調べて'],
    ['peer', 'sent', '仕様を確認して'],
    ['peer', 'received', '確認できた'],
    ['message', 'incoming', '確認できました'],
  ])
  assert.equal(timeline[1].peer, 'bell-grok-b')
  assert.equal(timeline[2].peer, 'bell-grok-b')
  assert.equal(timeline[1].peerPosition, '開発主任')
  assert.equal(timeline[2].peerPosition, '開発主任')
  assert.equal(timeline[0].image, true)
  assert.equal(timeline[0].delivery, 'failed')
  assert.equal(timeline[3].image, false)
})

test('合間の言葉はそのBotの会話画面にBotの発言として時刻順に並び、返信の記録には含めない', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-conversation-interim-'))
  const logPath = join(root, 'direct.jsonl')
  const records = [
    { schema: 'bellteam.direct-message.v1', delivery_id: '1', at: '2026-09-28T01:00:00.000Z', from: 'bell-grok-b', target: 'bell-grok-a', message: '見てほしい', delivery: 'running' },
    { schema: 'bellteam.interim-word.v1', id: 'w1', at: '2026-09-28T01:00:05.000Z', bot: 'bell-grok-a', group_id: '1', text: 'ちょっと見てくるね' },
    { schema: 'bellteam.interim-word.v1', id: 'w2', at: '2026-09-28T01:00:06.000Z', bot: 'bell-grok-b', group_id: '9', text: '別のBotの言葉' },
    { schema: 'bellteam.interim-word.v1', id: 'w3', at: '2026-09-28T01:00:08.000Z', bot: 'bell-grok-a', group_id: '1', text: '見た結果です', kind: 'answer' },
    { schema: 'bellteam.delivery-status.v1', delivery_id: '1', at: '2026-09-28T01:00:09.000Z', delivery: 'delivered' },
    { schema: 'bellteam.direct-message.v1', delivery_id: '2', at: '2026-09-28T01:00:10.000Z', from: 'bell-grok-a', target: 'user', message: '終わったよ', delivery: 'delivered' },
  ]
  await writeFile(logPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`)
  const store = new ConversationStore({ logPath })

  const timeline = await store.timeline('bell-grok-a')
  assert.deepEqual(timeline.map(item => [item.kind, item.direction, item.message]), [
    ['peer', 'received', '見てほしい'],
    ['interim', 'incoming', 'ちょっと見てくるね'],
    // Bot連絡で始まったターンの最終回答は、Ownerへの返信として出す。
    ['message', 'incoming', '見た結果です'],
    ['message', 'incoming', '終わったよ'],
  ])
  assert.equal(timeline[1].id, 'w1')
  assert.deepEqual((await store.records()).map(record => record.delivery_id), ['1', '2'])
  assert.equal((await store.records())[0].delivery, 'delivered')
})

test('corruption: ログ未作成は空、壊れた確定行は診断する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-conversation-empty-'))
  const logPath = join(root, 'direct.jsonl')
  const diagnostics = []
  const store = new ConversationStore({ logPath, onCorruption: value => diagnostics.push(value) })
  assert.deepEqual(await store.timeline('bell-grok-a'), [])

  await writeFile(logPath, '{broken}\n')
  assert.deepEqual(await store.timeline('bell-grok-a'), [])
  assert.deepEqual(diagnostics, [{ code: 'MESSAGE_LOG_INVALID', line: 1, offset: 0, length: 8, reason: 'syntax' }])
})

const line = record => `${JSON.stringify(record)}\n`
const direct = (id, extra = {}) => ({
  schema: 'bellteam.direct-message.v1', delivery_id: id, at: '2026-10-03T01:00:00.000Z', from: 'user', target: 'bell-grok-a', message: `m${id}`, delivery: 'running', ...extra,
})

test('corruption: 追記だけを読み足し、新readerは壊れた過去行を診断する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-conversation-append-'))
  const logPath = join(root, 'direct.jsonl')
  await writeFile(logPath, line(direct('1')))
  const store = new ConversationStore({ logPath })

  const first = await store.records()
  assert.deepEqual(first.map(record => [record.delivery_id, record.delivery]), [['1', 'running']])

  await appendFile(logPath, line({ schema: 'bellteam.delivery-status.v1', delivery_id: '1', delivery: 'delivered' }) + line(direct('2')))
  assert.deepEqual((await store.records()).map(record => [record.delivery_id, record.delivery]), [['1', 'delivered'], ['2', 'running']])
  assert.equal(first[0].delivery, 'running')

  // 読み終えた行は読み直さない。先頭を同じ長さの壊れた行に書き換えても、結果は変わらない。
  const file = await open(logPath, 'r+')
  await file.write('x'.repeat(Buffer.byteLength(line(direct('1'))) - 1), 0)
  await file.close()
  await appendFile(logPath, line(direct('3')))
  assert.deepEqual((await store.records()).map(record => record.delivery_id), ['1', '2', '3'])
  const diagnostics = []
  const fresh = new ConversationStore({ logPath, onCorruption: value => diagnostics.push(value) })
  assert.deepEqual((await fresh.records()).map(record => record.delivery_id), ['2', '3'])
  assert.equal(diagnostics[0].line, 1)
})

test('同時の呼び出しは同じ結果を返し、短くなったログは最初から読み直す', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-conversation-concurrent-'))
  const logPath = join(root, 'direct.jsonl')
  await writeFile(logPath, line(direct('1')) + line(direct('2')))
  const store = new ConversationStore({ logPath })

  const results = await Promise.all(Array.from({ length: 20 }, () => store.records()))
  for (const records of results) assert.deepEqual(records.map(record => record.delivery_id), ['1', '2'])

  await writeFile(logPath, line(direct('9')))
  assert.deepEqual((await store.records()).map(record => record.delivery_id), ['9'])
})

test('追記の途中で切れて見える最後の行は今回の結果に入れず、書き終わった後の読み込みで返す', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-conversation-partial-'))
  const logPath = join(root, 'direct.jsonl')
  const second = JSON.stringify(direct('2', { message: '途中で切れて見える行' }))
  const cut = Math.floor(Buffer.byteLength(second) / 2)
  await writeFile(logPath, Buffer.concat([Buffer.from(line(direct('1'))), Buffer.from(second).subarray(0, cut)]))
  const store = new ConversationStore({ logPath })

  // 書きかけの行で止めない。読めた行だけを返す。
  assert.deepEqual((await store.records()).map(record => record.delivery_id), ['1'])
  assert.deepEqual((await store.records()).map(record => record.delivery_id), ['1'])

  await appendFile(logPath, Buffer.concat([Buffer.from(second).subarray(cut), Buffer.from(`\n${line(direct('3'))}`)]))
  assert.deepEqual((await store.records()).map(record => [record.delivery_id, record.message]), [['1', 'm1'], ['2', '途中で切れて見える行'], ['3', 'm3']])
})

test('JSONとして書き終わった最後の行が知らない種類なら、改行が無くても止める', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-conversation-unknown-tail-'))
  const logPath = join(root, 'direct.jsonl')
  await writeFile(logPath, line(direct('1')) + JSON.stringify({ schema: 'unknown' }))
  await assert.rejects(new ConversationStore({ logPath }).records(), /MESSAGE_LOG_INVALID: line 2/)
})

test('corruption: 未改行previewを重ねず、確定不正行は一回だけ診断する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-conversation-tail-'))
  const logPath = join(root, 'direct.jsonl')
  await writeFile(logPath, line(direct('1')) + JSON.stringify(direct('2')))
  const diagnostics = []
  const store = new ConversationStore({ logPath, onCorruption: value => diagnostics.push(value) })

  assert.deepEqual((await store.records()).map(record => record.delivery_id), ['1', '2'])
  await appendFile(logPath, `\n${line(direct('3'))}`)
  assert.deepEqual((await store.records()).map(record => record.delivery_id), ['1', '2', '3'])

  await appendFile(logPath, '{broken}\n')
  assert.deepEqual((await store.records()).map(record => record.delivery_id), ['1', '2', '3'])
  await store.records()
  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0].line, 4)
})

async function corruptionFixture(t, content, onCorruption) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-corruption-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const logPath = join(root, 'direct.jsonl')
  await writeFile(logPath, content)
  const diagnostics = []
  const store = new ConversationStore({ logPath, onCorruption: onCorruption ?? (value => diagnostics.push(value)) })
  return { logPath, store, diagnostics }
}

test('corruption: 147NULに連結されたrecordは復元せず、前後の有効行と元bytesを保持する', async t => {
  const prefix = line(direct('before', { message: '日本語' }))
  const damaged = Buffer.concat([Buffer.alloc(147), Buffer.from(line(direct('joined')))])
  const bytes = Buffer.concat([Buffer.from(prefix), damaged, Buffer.from(line(direct('after')))])
  const { logPath, store, diagnostics } = await corruptionFixture(t, bytes)
  const before = await stat(logPath)
  assert.deepEqual((await store.records()).map(value => value.delivery_id), ['before', 'after'])
  assert.deepEqual(diagnostics, [{ code: 'MESSAGE_LOG_INVALID', line: 2, offset: Buffer.byteLength(prefix), length: damaged.length - 1, reason: 'nul' }])
  assert.deepEqual(await readFile(logPath), bytes)
  const after = await stat(logPath)
  assert.deepEqual([after.mtimeMs, after.mode, after.size], [before.mtimeMs, before.mode, before.size])
  assert.equal(store.read.offset, bytes.length)
  assert.equal(store.read.lines, 3)
})

test('corruption: 空行・schema拒否・syntax拒否の物理行とbyte位置を数え、状態を捏造しない', async t => {
  const prefix = line(direct('1', { message: 'あいう' })) + '\n'
  const badSchema = line({ schema: 'bellteam.delivery-status.v1', delivery_id: '1', delivery: 'made-up' })
  const badSyntax = '{"secret":"private-value" bad}\n'
  const goodStatus = line({ schema: 'bellteam.delivery-status.v1', delivery_id: '1', delivery: 'failed' })
  const { store, diagnostics } = await corruptionFixture(t, prefix + badSchema + badSyntax + goodStatus)
  const view = await store.timelineView('bell-grok-a')
  assert.equal((await store.records())[0].delivery, 'failed')
  assert.equal((await store.timeline('bell-grok-a'))[0].delivery, 'failed')
  assert.equal(await store.timelineView('bell-grok-a'), view)
  assert.deepEqual(diagnostics, [
    { code: 'MESSAGE_LOG_INVALID', line: 3, offset: Buffer.byteLength(prefix), length: Buffer.byteLength(badSchema) - 1, reason: 'schema' },
    { code: 'MESSAGE_LOG_INVALID', line: 4, offset: Buffer.byteLength(prefix + badSchema), length: Buffer.byteLength(badSyntax) - 1, reason: 'syntax' },
  ])
  assert(!JSON.stringify(diagnostics).includes('private-value'))
  assert(diagnostics.every(Object.isFrozen))
  assert.equal(store.read.lines, 5)
})

test('corruption: 不正行だけの追記でもoffsetを進め、次の追記と同時読取で診断を重ねない', async t => {
  const { logPath, store, diagnostics } = await corruptionFixture(t, '{bad}\n\n')
  await Promise.all(Array.from({ length: 8 }, () => store.records()))
  assert.equal(diagnostics.length, 1)
  assert.equal(store.read.lines, 2)
  assert.equal(store.read.offset, 7)
  await appendFile(logPath, '{}\n' + line(direct('1')))
  assert.deepEqual((await store.records()).map(value => value.delivery_id), ['1'])
  assert.deepEqual(diagnostics[1], { code: 'MESSAGE_LOG_INVALID', line: 3, offset: 7, length: 2, reason: 'schema' })
})

test('corruption: 未確定の破損末尾は保留し、LF確定後だけ診断して次のpreviewを保持する', async t => {
  const { logPath, store, diagnostics } = await corruptionFixture(t, line(direct('1')) + '\0'.repeat(147))
  assert.deepEqual((await store.records()).map(value => value.delivery_id), ['1'])
  assert.equal(diagnostics.length, 0)
  await appendFile(logPath, '\n' + JSON.stringify(direct('2')))
  assert.deepEqual((await store.records()).map(value => value.delivery_id), ['1', '2'])
  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0].line, 2)
  assert.equal(store.read.lines, 2)
  assert.deepEqual((await store.records()).map(value => value.delivery_id), ['1', '2'])
  await appendFile(logPath, '\n' + line(direct('3')))
  assert.deepEqual((await store.records()).map(value => value.delivery_id), ['1', '2', '3'])
  assert.equal(store.read.lines, 4)
  await appendFile(logPath, JSON.stringify({ schema: 'unknown' }))
  await assert.rejects(store.records(), /MESSAGE_LOG_INVALID: line 5/)
})

test('corruption: previewに不正な続きが確定したら取り除き、後続statusと有効行を読む', async t => {
  const { logPath, store, diagnostics } = await corruptionFixture(t, line(direct('1')) + JSON.stringify(direct('2')))
  assert.deepEqual((await store.records()).map(value => value.delivery_id), ['1', '2'])
  await appendFile(logPath, '\0\n' + line({ schema: 'bellteam.delivery-status.v1', delivery_id: '1', delivery: 'delivered' }) + line(direct('3')))
  assert.deepEqual((await store.records()).map(value => [value.delivery_id, value.delivery]), [['1', 'delivered'], ['3', 'running']])
  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0].line, 2)
})

test('corruption: previewだけが不正行として確定した場合も変更を通知する', async t => {
  const { logPath, store, diagnostics } = await corruptionFixture(t, JSON.stringify(direct('preview')))
  assert.equal((await store.records()).length, 1)
  const changes = []
  store.listeners.add(value => changes.push(value))
  await appendFile(logPath, '\0\n')
  assert.deepEqual(await store.records(), [])
  assert.equal(diagnostics.length, 1)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].all, true)
})

test('corruption: 同size置換・inode置換・短縮時は物理位置と診断を新ファイルから再構築する', async t => {
  const original = '{bad}\n' + line(direct('1'))
  const { logPath, store, diagnostics } = await corruptionFixture(t, original)
  await store.records()
  await writeFile(logPath, '{err}\n' + line(direct('2')))
  assert.deepEqual((await store.records()).map(value => value.delivery_id), ['2'])
  await writeFile(logPath + '.new', original)
  await rename(logPath + '.new', logPath)
  assert.deepEqual((await store.records()).map(value => value.delivery_id), ['1'])
  await writeFile(logPath, '{}\n')
  assert.deepEqual(await store.records(), [])
  assert.deepEqual(diagnostics.map(value => [value.line, value.offset]), [[1, 0], [1, 0], [1, 0], [1, 0]])
  assert.equal(store.read.lines, 1)
  assert.equal(store.read.offset, 3)
})

test('corruption: 診断callbackのthrow・reject・未終端を履歴へ伝播せず、既定診断にも本文を出さない', async t => {
  const logged = []
  t.mock.method(console, 'error', value => logged.push(JSON.parse(value)))
  for (const callback of [() => { throw new Error('private-throw') }, async () => { throw new Error('private-reject') }, () => new Promise(() => {})]) {
    const { store } = await corruptionFixture(t, '{"secret":"private-body" bad}\n' + line(direct('1')), callback)
    assert.deepEqual((await store.records()).map(value => value.delivery_id), ['1'])
  }
  const { logPath } = await corruptionFixture(t, '{}\n' + line(direct('1')))
  assert.equal((await new ConversationStore({ logPath }).records()).length, 1)
  assert.equal(logged.length, 3)
  assert(logged.every(value => value.code === 'MESSAGE_LOG_INVALID'))
  assert(!JSON.stringify(logged).includes('private-'))
})
