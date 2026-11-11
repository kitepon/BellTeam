import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { memberRow, memberState, roomRow, rowTime } from '../web/roster-view.js'

const { currentWork: w } = JSON.parse(await readFile(new URL('fixtures/web-current-work.json', import.meta.url)))

test('row time: today as hh:mm, 昨日, older as m/d, nothing without a time', () => {
  const now = new Date(2026, 10, 12, 9, 0).getTime()
  assert.equal(rowTime(new Date(2026, 10, 12, 8, 5).toISOString(), now), '08:05')
  assert.equal(rowTime(new Date(2026, 10, 11, 23, 59).toISOString(), now), '昨日')
  assert.equal(rowTime(new Date(2026, 10, 9, 12, 0).toISOString(), now), '11/9')
  for (const value of [undefined, null, '', 'invalid']) assert.equal(rowTime(value, now), '')
})

test('member row: name only, summary or role, never 未取得, one state badge', () => {
  const bot = { name: 'トロニー', displayName: 'トロニー 本番', position: '本番', currentWork: w.idle }
  assert.deepEqual(memberRow(bot), { name: 'トロニー', line: '本番', state: null })
  assert.deepEqual(memberRow({ ...bot, currentWork: w.workingCurrent }), { name: 'トロニー', line: w.workingCurrent.summary, state: { text: '作業中', tone: 'working', reason: '' } })
  for (const currentWork of [undefined, w.workingMissing, w.workingStale, w.unknownLastObservation]) assert.doesNotMatch(memberRow({ ...bot, currentWork }).line, /未取得|期限切れ/u)
  assert.equal(memberRow({ ...bot, position: '' }).line, '')
  // 要対応 beats 作業中 and says why on line 2; raw codes stay off the row.
  const seat = memberRow({ ...bot, currentWork: w.workingCurrent, seatLaunch: { code: 'SEAT_X', action: '' } })
  assert.deepEqual(seat.state, { text: '要対応', tone: 'attention', reason: '端末で起動できません' })
  assert.equal(seat.line, '端末で起動できません')
  assert.equal(memberState({ ...bot, deletionRequested: true }).reason, '削除の結果待ち')
})

test('room row: last message with sender, else purpose; participant match reason; working members', () => {
  const bots = [{ id: 'a', name: 'トロニー', position: '本番', currentWork: w.workingCurrent }, { id: 'b', name: 'モリー', position: '本体', currentWork: w.idle }]
  const room = { name: '開発', purpose: 'Webを直す', memberIds: ['a', 'b'], recent: { sender: { id: 'b', name: 'モリー' }, message: '出ました\n本番', at: '2026-11-12T00:00:00Z' } }
  assert.equal(roomRow(room, bots).line, 'モリー: 出ました 本番')
  assert.equal(roomRow({ ...room, recent: { ...room.recent, sender: { id: 'user' } } }, bots).line, 'あなた: 出ました 本番')
  assert.equal(roomRow({ ...room, recent: null }, bots).line, 'Webを直す')
  assert.equal(roomRow(room, bots, 'トロ').line, '参加者: トロニー')
  assert.equal(roomRow(room, bots, '開発').line, 'モリー: 出ました 本番')
  assert.deepEqual(roomRow(room, bots).working.map(bot => bot.id), ['a'])
})
