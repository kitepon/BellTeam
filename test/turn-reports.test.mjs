import assert from 'node:assert/strict'
import test from 'node:test'

import { TurnReports, judgeOwnerReport, reportRequestMessage, turnView } from '../src/turn-reports.mjs'

const word = (at, text, extra = {}) => ({ schema: 'bellteam.interim-word.v1', id: `w-${at}`, at, bot: 'bot-d', group_id: 'g', text, ...extra })
const dm = (at, from, target, message) => ({ schema: 'bellteam.direct-message.v1', delivery_id: `d-${at}`, at, from, target, message })
const window = { startedAt: '2026-09-30T23:07:27Z', endedAt: '2026-09-30T23:08:12Z' }

// 2026-09-30 23:07 のドリリーのターン（指揮官の問いへの答えがドロシー宛てにだけ書かれた）。
const driley = [
  dm('2026-09-30T23:07:26Z', 'user', 'bot-d', '許可を絞ったら、RTKの機能は何割程度限定される？'),
  word('2026-09-30T23:07:45Z', 'rabbitのCodexは承認もsandboxも最初から無い。macbookとfoxも確認するよ。'),
  dm('2026-09-30T23:08:05Z', 'bot-d', 'bot-o', '指揮官には、許可を絞ってもRTKの効きは0割しか減らないと答えた。'),
  dm('2026-09-30T23:08:11Z', 'bot-d', 'user', '記録も手順書に残した。指揮官の返事を待ってる。'),
  word('2026-09-30T23:09:00Z', '次のターンの言葉'),
  dm('2026-09-30T23:06:00Z', 'bot-d', 'bot-o', '前のターンの連絡'),
]

const bots = new Map([['bot-d', { id: 'bot-d', name: 'ドリリー' }], ['bot-o', { id: 'bot-o', name: 'ドロシー' }]])

function reports({ records, judge }) {
  const notified = []
  const appended = []
  const reported = []
  const service = new TurnReports({
    bots,
    store: { entries: async () => records },
    transport: { notify: async (bot, message, options) => { notified.push({ bot: bot.id, message, options }); return { delivery: 'running' } } },
    appendInterimWords: async (...args) => appended.push(args),
    judge,
    report: message => reported.push(message),
    messageId: () => 'report-1',
  })
  return { service, notified, appended, reported }
}

test('ターンの間にオーナーの画面へ出たものと、メンバーへ送ったものを分ける', () => {
  const view = turnView(driley, { botId: 'bot-d', ...window, names: id => bots.get(id).name })
  assert.deepEqual(view, {
    ownerView: {
      progress_notes: ['rabbitのCodexは承認もsandboxも最初から無い。macbookとfoxも確認するよ。'],
      messages_to_owner: [],
      final_message: '記録も手順書に残した。指揮官の返事を待ってる。',
    },
    memberMessages: [{ to: 'ドロシー', text: '指揮官には、許可を絞ってもRTKの効きは0割しか減らないと答えた。' }],
  })
})

test('メンバーへ送った要点がオーナーへの言葉に無ければ、そのBotへ報告を頼む', async () => {
  const judged = []
  const { service, notified, appended } = reports({ records: driley, judge: async input => { judged.push(input); return { outcome: 0.18, substance: 0.41 } } })
  const result = await service.check({ botId: 'bot-d', context: 'owner', ...window })
  assert.deepEqual(result, { reason: 'content', recipients: ['ドロシー'], groupId: 'report-1' })
  assert.equal(judged.length, 1)
  assert.equal(notified[0].bot, 'bot-d')
  assert.equal(notified[0].message, reportRequestMessage('content', ['ドロシー']))
  assert.match(notified[0].message, /「ドロシー」へ送った内容/u)
  assert.equal(notified[0].options.queue.context, 'report')
  assert.equal(notified[0].options.onTurnEnd, undefined)
  await notified[0].options.onAnswer('指揮官、許可を絞っても0割しか減らないよ。')
  assert.deepEqual(appended, [['bot-d', 'report-1', [{ text: '指揮官、許可を絞っても0割しか減らないよ。', kind: 'answer' }]]])
})

test('要点が伝わっていれば頼まない。どちらかの値が基準を下回れば頼む', async () => {
  for (const [answer, expected] of [
    [{ outcome: 0.8, substance: 0.9 }, null],
    [{ outcome: 0.34, substance: 0.9 }, 'content'],
    [{ outcome: 0.8, substance: 0.12 }, 'content'],
  ]) {
    const { service } = reports({ records: driley, judge: async () => answer })
    assert.equal((await service.check({ botId: 'bot-d', context: 'direct', ...window }))?.reason ?? null, expected)
  }
})

test('オーナーの画面に何も残らなかったターンは、Jevを使わずに処理漏れとして報告を頼む', async () => {
  const records = [dm('2026-09-30T23:08:05Z', 'bot-d', 'bot-o', 'ドロシーへの返事')]
  const { service, notified } = reports({ records, judge: async () => { throw new Error('使わない') } })
  const result = await service.check({ botId: 'bot-d', context: 'direct', ...window })
  assert.equal(result.reason, 'missing')
  assert.equal(notified[0].message, reportRequestMessage('missing', []))
})

test('ルームのターンは画面に何も残らなくても漏れにしない。メンバーへ送っていなければ判定もしない', async () => {
  const { service, notified } = reports({ records: [], judge: async () => { throw new Error('使わない') } })
  assert.equal(await service.check({ botId: 'bot-d', context: 'room', ...window }), null)
  const answered = [word('2026-09-30T23:08:00Z', '結果はこうだったよ。', { kind: 'answer' })]
  const second = reports({ records: answered, judge: async () => { throw new Error('使わない') } })
  assert.equal(await second.service.check({ botId: 'bot-d', context: 'direct', ...window }), null)
  assert.equal(notified.length, 0)
})

test('確かめられなかった時は報告を頼まず、理由を記録する', async () => {
  const { service, notified, reported } = reports({ records: driley, judge: async () => { throw new Error('JEV_HTTP_529') } })
  await service.afterTurn({ botId: 'bot-d', context: 'owner', ...window })
  assert.equal(notified.length, 0)
  assert.deepEqual(reported, ['BellTeam turn report: bot-d を確かめられませんでした（JEV_HTTP_529）'])
})

test('Jevへ英語の問い2つと会話の原文を送り、確率を受け取る', async () => {
  const calls = []
  const fetcher = async (url, options) => {
    calls.push([url, JSON.parse(options.body), options.headers.authorization])
    return { ok: true, json: async () => ({ model: 'jev-1.13.0', answers: { outcome: { type: 'noul', noul: 0.18 }, substance: { type: 'noul', noul: 0.41 } } }) }
  }
  const { ownerView, memberMessages } = turnView(driley, { botId: 'bot-d', ...window })
  assert.deepEqual(await judgeOwnerReport({ ownerView, memberMessages, fetcher, apiKey: 'key' }), { outcome: 0.18, substance: 0.41 })
  const [url, body, authorization] = calls[0]
  assert.equal(url, 'https://api.typesafe.ai/v1/systemone')
  assert.equal(authorization, 'Bearer key')
  assert.equal(body.model, 'jev-latest')
  assert.deepEqual(body.state, { owner_view: ownerView, member_messages: memberMessages })
  assert.deepEqual(Object.keys(body.questions), ['outcome', 'substance'])
  assert.ok(Object.values(body.questions).every(question => question.type === 'noul' && question.criteria.true && question.criteria.false))
  await assert.rejects(judgeOwnerReport({ ownerView, memberMessages, apiKey: 'key',
    fetcher: async () => ({ ok: true, json: async () => ({ answers: { outcome: { noul: 2 } } }) }) }), /JEV_RESPONSE_INVALID/u)
  await assert.rejects(judgeOwnerReport({ ownerView, memberMessages, apiKey: '' }), /JEV_API_KEY_MISSING/u)
})
