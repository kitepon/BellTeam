import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createBellTeamServer } from '../src/http-server.mjs'
import { OwnerQuestions, ownerAnswerMessage } from '../src/owner-questions.mjs'

const bots = new Map([['bot-d', { id: 'bot-d', name: 'ドリリー' }]])

async function service(notified = []) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-owner-question-'))
  const requested = []
  const questions = new OwnerQuestions({
    root, bots, notify: async item => notified.push(item), onRequest: item => requested.push(item.id),
    now: () => '2026-10-01T00:00:00.000Z', id: () => '6f1e2d3c-0000-4000-8000-000000000001',
  })
  await questions.initialize()
  return { questions, root, requested }
}

test('選択肢のカードを作り、そのBotの会話画面に出す', async () => {
  const { questions, root, requested } = await service()
  const item = await questions.create({ botId: 'bot-d', question: 'CodexにRTKを入れていい？', options: ['入れて', 'まだ待って'] })
  assert.deepEqual(item, {
    id: '6f1e2d3c-0000-4000-8000-000000000001', botId: 'bot-d', question: 'CodexにRTKを入れていい？',
    options: ['入れて', 'まだ待って'], allowOther: true, at: '2026-10-01T00:00:00.000Z', status: 'open',
  })
  assert.deepEqual(requested, [item.id])
  assert.deepEqual(questions.timeline({ botId: 'bot-d' }).map(entry => [entry.kind, entry.message, entry.owner_question.status]),
    [['owner_question', 'CodexにRTKを入れていい？', 'open']])
  assert.deepEqual(questions.timeline({ botId: 'bot-x' }), [])
  // 再起動しても残る。
  const reloaded = new OwnerQuestions({ root, bots, notify: async () => {} })
  await reloaded.initialize()
  assert.equal(reloaded.get(item.id).question, 'CodexにRTKを入れていい？')
  assert.equal(JSON.parse(await readFile(join(root, 'state/owner-questions', `${item.id}.json`), 'utf8')).status, 'open')
})

test('選択肢は2〜8個の重複しない文に限る', async () => {
  const { questions } = await service()
  for (const input of [
    { botId: 'bot-d', question: '', options: ['a', 'b'] },
    { botId: 'bot-d', question: 'q', options: ['a'] },
    { botId: 'bot-d', question: 'q', options: ['a', 'a'] },
    { botId: 'bot-d', question: 'q', options: ['a', ' '] },
    { botId: 'bot-d', question: 'q', options: Array.from({ length: 9 }, (_, i) => `${i}`) },
  ]) await assert.rejects(questions.create(input), /OWNER_QUESTION_INVALID/u)
  await assert.rejects(questions.create({ botId: 'bot-x', question: 'q', options: ['a', 'b'] }), /BOT_NOT_FOUND/u)
})

test('選んだ答えか文章の答えをBotへ届け、答えたカードには二度と答えられない', async () => {
  const notified = []
  const { questions } = await service(notified)
  const item = await questions.create({ botId: 'bot-d', question: 'どうする？', options: ['入れて', '待って'] })
  await assert.rejects(questions.answer(item.id, { choice: '別の案' }), /OWNER_QUESTION_ANSWER_INVALID/u)
  const answered = await questions.answer(item.id, { choice: '入れて' })
  assert.equal(answered.status, 'answered')
  assert.equal(answered.answer, '入れて')
  assert.equal(answered.other, false)
  assert.equal(ownerAnswerMessage(notified[0]), 'あなたが選択肢で尋ねた「どうする？」への回答です。\n\n入れて')
  await assert.rejects(questions.answer(item.id, { choice: '待って' }), /OWNER_QUESTION_CLOSED/u)
})

test('その他を許さないカードは文章の答えを受けない', async () => {
  const { questions } = await service()
  const item = await questions.create({ botId: 'bot-d', question: 'どれ？', options: ['A', 'B'], allowOther: false })
  await assert.rejects(questions.answer(item.id, { text: 'Cにして' }), /OWNER_QUESTION_ANSWER_INVALID/u)
  const other = await service()
  const open = await other.questions.create({ botId: 'bot-d', question: 'どれ？', options: ['A', 'B'] })
  const answered = await other.questions.answer(open.id, { text: ' Cにして ' })
  assert.deepEqual([answered.answer, answered.other], ['Cにして', true])
})

test('作成はMCPからの内部APIだけ、回答は公開APIだけで受ける', async t => {
  const notified = []
  const { questions } = await service(notified)
  const common = { bots, ownerQuestions: questions, messenger: {}, transport: {}, authorize: () => true,
    store: { timeline: async () => [], records: async () => [] } }
  const publicServer = createBellTeamServer(common)
  const internalServer = createBellTeamServer({ ...common, internal: true })
  for (const server of [publicServer, internalServer]) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close()) }
  const url = server => `http://127.0.0.1:${server.address().port}`
  const post = (server, path, body) => fetch(`${url(server)}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  assert.equal((await post(publicServer, '/api/owner-questions', { botId: 'bot-d', question: 'q', options: ['a', 'b'] })).status, 404)
  const created = await post(internalServer, '/api/owner-questions', { botId: 'bot-d', question: '入れていい？', options: ['はい', 'いいえ'] })
  assert.equal(created.status, 201)
  const { question } = await created.json()
  const timeline = await (await fetch(`${url(publicServer)}/api/bots/bot-d/messages`)).json()
  assert.deepEqual(timeline.items.map(item => item.kind), ['owner_question'])
  assert.equal((await post(internalServer, `/api/owner-questions/${question.id}/answer`, { choice: 'はい' })).status, 405)
  assert.equal((await post(publicServer, `/api/owner-questions/${question.id}/answer`, { choice: 'たぶん' })).status, 400)
  const answered = await post(publicServer, `/api/owner-questions/${question.id}/answer`, { choice: 'はい' })
  assert.equal(answered.status, 200)
  assert.equal((await answered.json()).question.answer, 'はい')
  assert.equal((await post(publicServer, `/api/owner-questions/${question.id}/answer`, { choice: 'いいえ' })).status, 409)
  assert.equal(notified.length, 1)
})
