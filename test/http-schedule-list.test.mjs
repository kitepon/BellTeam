import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { createBellTeamServer } from '../src/http-server.mjs'

test('全予定は認証付き一要求で全Bot/roomの既存Scheduleを返し、個別APIを保つ', async t => {
  const bots = new Map([['bot-a', { id: 'bot-a', displayName: '担当A' }], ['bot-b', { id: 'bot-b', name: '担当B' }]])
  const rooms = new Map([['room-a', { id: 'room-a', name: '相談' }]])
  const reads = [], schedule = { id: 'same-id', kind: 'once', enabled: true, prompt: '原文' }
  bots.listSchedules = async id => { reads.push(id); return id === 'bot-a' ? [schedule] : [] }
  rooms.listSchedules = async id => { reads.push(id); return [{ ...schedule, targets: ['bot-a'] }] }
  let refreshes = 0
  rooms.refresh = async () => { refreshes++ }
  const server = createBellTeamServer({ bots, rooms, authorize: r => r.headers.authorization === 'test', transport: {}, store: {} })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  assert.equal((await fetch(base + '/api/schedules')).status, 401)
  assert.equal(reads.length, 0)
  const response = await fetch(base + '/api/schedules', { headers: { authorization: 'test' } })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { sources: [
    { kind: 'bot', id: 'bot-a', name: '担当A', schedules: [schedule] },
    { kind: 'bot', id: 'bot-b', name: '担当B', schedules: [] },
    { kind: 'room', id: 'room-a', name: '相談', schedules: [{ ...schedule, targets: ['bot-a'] }] },
  ] })
  assert.deepEqual(reads.sort(), ['bot-a', 'bot-b', 'room-a'])
  assert.equal(refreshes, 1)
  assert.deepEqual(await (await fetch(base + '/api/bots/bot-a/schedules', { headers: { authorization: 'test' } })).json(), { schedules: [schedule] })
  rooms.listSchedules = async () => { throw new Error('read failed') }
  assert.equal((await fetch(base + '/api/schedules', { headers: { authorization: 'test' } })).status, 500)
})
