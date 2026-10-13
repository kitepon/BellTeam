import assert from 'node:assert/strict'
import test from 'node:test'

import { SeatTurns } from '../src/seat-turns.mjs'

const bots = new Map([['bot-r', { id: 'bot-r', project: '/srv/bellteam/bots/bot-r' }]])

test('席の今のターンを聞く時、全Botと合間の言葉の出し先を渡す', async () => {
  const asked = []
  const append = async () => {}
  const service = new SeatTurns({
    bots, appendInterimWords: append,
    transport: { async watchSeatTurns(list, options) { asked.push([list.map(bot => bot.id), options.onInterim]); return true } },
  })
  await service.poll()
  assert.deepEqual(asked, [[['bot-r'], append]])
})

test('聞くのに失敗しても、次も聞き続ける', async () => {
  let polls = 0
  const reported = []
  const service = new SeatTurns({
    bots, appendInterimWords: async () => {}, report: message => reported.push(message), intervalMs: 1,
    transport: { async watchSeatTurns() { if (++polls === 1) throw new Error('AITERM_SEAT_TURNS_INVALID: ENOENT'); return true } },
  })
  service.start()
  while (polls < 3) await new Promise(resolve => setTimeout(resolve, 1))
  await service.stop()
  assert.deepEqual(reported, ['BellTeam seat turns: AITERM_SEAT_TURNS_INVALID: ENOENT'])
})

test('席の今のターンを返さないAitermには、1回聞いてやめる', async () => {
  let polls = 0
  const reported = []
  const service = new SeatTurns({
    bots, appendInterimWords: async () => {}, report: message => reported.push(message), intervalMs: 1,
    transport: { async watchSeatTurns() { polls++; return false } },
  })
  service.start()
  while (polls < 1) await new Promise(resolve => setTimeout(resolve, 1))
  await service.running
  await new Promise(resolve => setTimeout(resolve, 20))
  await service.stop()
  assert.equal(polls, 1)
  assert.equal(reported.length, 1)
})
