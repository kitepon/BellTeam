import assert from 'node:assert/strict'
import { appendFile, mkdtemp, open, writeFile } from 'node:fs/promises'
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
    { schema: 'bellteam.delivery-status.v1', delivery_id: '1', at: '2026-09-28T01:00:09.000Z', delivery: 'delivered' },
    { schema: 'bellteam.direct-message.v1', delivery_id: '2', at: '2026-09-28T01:00:10.000Z', from: 'bell-grok-a', target: 'user', message: '終わったよ', delivery: 'delivered' },
  ]
  await writeFile(logPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`)
  const store = new ConversationStore({ logPath })

  const timeline = await store.timeline('bell-grok-a')
  assert.deepEqual(timeline.map(item => [item.kind, item.direction, item.message]), [
    ['peer', 'received', '見てほしい'],
    ['interim', 'incoming', 'ちょっと見てくるね'],
    ['message', 'incoming', '終わったよ'],
  ])
  assert.equal(timeline[1].id, 'w1')
  assert.deepEqual((await store.records()).map(record => record.delivery_id), ['1', '2'])
  assert.equal((await store.records())[0].delivery, 'delivered')
})

test('ログ未作成は空、壊れたJSONLは明示エラーにする', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-conversation-empty-'))
  const logPath = join(root, 'direct.jsonl')
  const store = new ConversationStore({ logPath })
  assert.deepEqual(await store.timeline('bell-grok-a'), [])

  await writeFile(logPath, '{broken}\n')
  await assert.rejects(store.timeline('bell-grok-a'), /MESSAGE_LOG_INVALID/)
})

const line = record => `${JSON.stringify(record)}\n`
const direct = (id, extra = {}) => ({
  schema: 'bellteam.direct-message.v1', delivery_id: id, at: '2026-10-03T01:00:00.000Z', from: 'user', target: 'bell-grok-a', message: `m${id}`, delivery: 'running', ...extra,
})

test('追記された行だけを読み足し、後から届いた配送状態も前の記録へ反映する', async () => {
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
  await assert.rejects(new ConversationStore({ logPath }).records(), /MESSAGE_LOG_INVALID: line 1/)
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

test('改行で終わっていない最後の行も返し、続きが書かれても重ねない。壊れた行は毎回同じ行番号で知らせる', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-conversation-tail-'))
  const logPath = join(root, 'direct.jsonl')
  await writeFile(logPath, line(direct('1')) + JSON.stringify(direct('2')))
  const store = new ConversationStore({ logPath })

  assert.deepEqual((await store.records()).map(record => record.delivery_id), ['1', '2'])
  await appendFile(logPath, `\n${line(direct('3'))}`)
  assert.deepEqual((await store.records()).map(record => record.delivery_id), ['1', '2', '3'])

  await appendFile(logPath, '{broken}\n')
  await assert.rejects(store.records(), /MESSAGE_LOG_INVALID: line 4/)
  await assert.rejects(store.records(), /MESSAGE_LOG_INVALID: line 4/)
})
