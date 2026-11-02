import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OwnerQuestions } from '../src/owner-questions.mjs'
import { createOlrwAuthorization, attachOlrwOwnerQuestion } from '../src/olrw-management-caller.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const decision = { decision_id: 'K-ABC123', version: 3, status: 'answered', requester: 'synthetic',
  context: 'fixed synthetic target and operations', options: [{ id: 'allow', label: 'synthetic allow' }],
  answer: { option_id: 'allow', answered_at: '2026-11-03T00:00:00Z' } }
const plan = { decisionId: decision.decision_id, version: 3, connectionId: 'connection', userId: 'owner',
  optionId: 'allow', requester: 'synthetic', contextSha256: hash(decision.context),
  optionsSha256: hash(JSON.stringify(decision.options)), expiresAt: '2026-11-04T00:00:00Z', actions: ['start'] }

test('固定originの原本GETだけを使い、正規接続/Owner/回答済み版/本文を照合する', async () => {
  const calls = []
  const check = createOlrwAuthorization({ plan, readBearer: async () => 'synthetic-token', now: () => Date.parse('2026-11-03T01:00:00Z'),
    fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json(url.endsWith('/connection')
      ? { connection_id: 'connection', me: { user_id: 'owner' } } : decision) } })
  assert.equal(await check('start'), undefined)
  assert.deepEqual(calls.map(x => x.url), ['https://approval-box.kitepon.dev/connector/v1/connection', 'https://approval-box.kitepon.dev/connector/v1/decisions/K-ABC123'])
  assert.ok(calls.every(x => x.options.method === 'GET' && x.options.redirect === 'error'))
  await assert.rejects(check('cancel'), /OLRW_AUTHORIZATION_UNAVAILABLE/)
  assert.equal(calls.length, 2)
})

test('未回答/取消/test/別選択/版変更/本文変更/別Owner/期限/取得失敗は固定拒否し秘密を返さない', async () => {
  for (const changed of [{ status: 'pending' }, { status: 'cancelled' }, { test: true }, { version: 4 },
    { answer: { ...decision.answer, option_id: 'deny' } }, { context: 'changed' }]) {
    const check = createOlrwAuthorization({ plan, readBearer: async () => 'synthetic-token', now: () => Date.parse('2026-11-03T01:00:00Z'),
      fetchImpl: async url => Response.json(url.endsWith('/connection') ? { connection_id: 'connection', me: { user_id: 'owner' } } : { ...decision, ...changed }) })
    await assert.rejects(check('start'), { message: 'OLRW_AUTHORIZATION_UNAVAILABLE' })
  }
  for (const fetchImpl of [async () => Response.json({ connection_id: 'connection', me: { user_id: 'other' } }),
    async () => { throw new Error('synthetic-token') }, async () => new Response('x'.repeat(65537))]) {
    const check = createOlrwAuthorization({ plan, readBearer: async () => 'synthetic-token', now: () => Date.parse('2026-11-03T01:00:00Z'), fetchImpl })
    await assert.rejects(check('start'), { message: 'OLRW_AUTHORIZATION_UNAVAILABLE' })
  }
  const check = createOlrwAuthorization({ plan, readBearer: async () => { assert.fail('expired must not read credential') }, now: () => Date.parse(plan.expiresAt) })
  await assert.rejects(check('start'), /OLRW_AUTHORIZATION_UNAVAILABLE/)
})

test('既カードの回答で一回だけconsumerを呼び、既回答起動/中断後の再送を拒否する', async () => {
  const fixed = { questionId: 'question', requesterBotId: 'bot', question: 'synthetic start?', options: ['yes', 'no'], answer: 'yes' }
  const item = { id: 'question', botId: 'bot', question: fixed.question, options: fixed.options, allowOther: false, status: 'open' }
  let listener, executions = 0, closes = 0, check
  const options = { plan: fixed, ownerQuestions: { get: () => ({ ...item }), watch: callback => { listener = callback; return () => {} } },
    aiControl: { admit: () => () => {} }, assertAuthorized: async () => {},
    createConsumer: ({ assertAuthorized }) => { check = assertAuthorized; return { execute: async () => { executions++; await check('start') }, close: async () => { closes++ } } },
    reportFailure: () => assert.fail('unexpected failure') }
  const caller = attachOlrwOwnerQuestion(options)
  item.status = 'answered'; item.answer = 'yes'; item.other = false
  listener(); listener(); await caller.result
  assert.equal(executions, 1)
  const dormant = attachOlrwOwnerQuestion({ ...options, createConsumer: () => assert.fail('answered card cannot construct consumer') })
  assert.equal(dormant.status, 'already_answered')
  assert.equal(dormant.result, null)
  await dormant.close()
  await caller.close()
  await assert.rejects(check('start'), { name: 'AbortError' })
  assert.equal(closes, 1)
})

test('実OwnerQuestionsの保存後watchから一回実行し、親停止epoch変更はnative前に拒否する', async t => {
  const root = await mkdtemp(join(tmpdir(), 'olrw-caller-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const questions = new OwnerQuestions({ root, bots: new Map([['bot', { name: 'synthetic' }]]), notify: async () => {} })
  await questions.initialize()
  const item = await questions.create({ botId: 'bot', question: 'synthetic start?', options: ['yes', 'no'], allowOther: false })
  let epoch = 0, execute = 0, failure = null
  const caller = attachOlrwOwnerQuestion({ plan: { questionId: item.id, requesterBotId: 'bot', question: item.question, options: item.options, answer: 'yes' },
    ownerQuestions: questions, aiControl: { admit: () => { const admitted = epoch; return () => { if (epoch !== admitted) throw new Error('stopped') } } },
    assertAuthorized: async () => { epoch++ }, createConsumer: () => ({ execute: async () => { execute++ }, close: async () => {} }),
    reportFailure: code => { failure = code } })
  t.after(() => caller.close())
  await questions.answer(item.id, { choice: 'yes' })
  await caller.result
  assert.equal(questions.get(item.id).status, 'answered')
  assert.equal(execute, 0)
  assert.equal(failure, 'OLRW_MANAGEMENT_EXECUTION_UNCONFIRMED')
})
