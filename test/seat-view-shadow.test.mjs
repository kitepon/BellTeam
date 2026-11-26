import assert from 'node:assert/strict'
import test from 'node:test'
import { genericSeatData, seatViewDifferences, SeatViewShadow } from '../src/seat-view-shadow.mjs'

const running = { state: 'running', turn_id: 't1', started_at: '2026-11-23T00:00:00.000Z', interim_from: 'v1:3:b:9', event_cursor: null, wait_process: null }
const own = { processes: 0, excluded: 0, child_results: 0, tasks: 0, exclusions_digest: 'd', oldest: null, task: null }
const row = (session, turn, own_work = own) => ({ session_id: session, harness: 'claude-code', turn, own_work })

test('equal generic and Aiterm-shaped rows are not a difference (event_cursor and wait_process are ignored)', () => {
  const sessions = [{ session_id: 'a', turn: { ...running, event_cursor: 7 }, own_work: own }, { session_id: 'b', turn: { state: 'idle' }, own_work: own }]
  assert.deepEqual(seatViewDifferences({ rows: [row('a', running), row('b', { state: 'idle' })], sessions }), [])
})

test('a different state, turn id or own work is named by field and seat', () => {
  const sessions = [{ session_id: 'a', turn: { state: 'idle' }, own_work: own }, { session_id: 'b', turn: { state: 'idle' }, own_work: { ...own, tasks: 2 } }]
  assert.deepEqual(seatViewDifferences({ rows: [row('a', running), row('b', { state: 'idle' })], sessions }),
    [{ session: 'a', harness: 'claude-code', field: 'turn' }, { session: 'b', harness: 'claude-code', field: 'own_work' }])
})

test('unread in Aiterm means turn null in the generic read; a seat without the generic fields is not compared', () => {
  assert.deepEqual(seatViewDifferences({ rows: [], unread: ['a', 'b'], sessions: [{ session_id: 'a', turn: null }, { session_id: 'b', turn: { state: 'idle' } }] }), [])
  assert.deepEqual(seatViewDifferences({ rows: [row('a', running)], unread: [], sessions: [{ session_id: 'a' }] }), [])
})

test('counts every compared row, reports a difference once per seat and field per minute, and never throws on an old Aiterm', () => {
  let clock = 0
  const lines = [], shadow = new SeatViewShadow({ report: line => lines.push(line), now: () => clock })
  const data = { seats: [row('a', running)], unread: [] }, result = { structuredContent: { sessions: [{ session_id: 'a', turn: { state: 'idle' }, own_work: own }] } }
  shadow.compare(data, result); shadow.compare(data, result)
  clock = 61_000; shadow.compare(data, result)
  assert.equal(lines.filter(line => line.includes('SEAT_VIEW_SHADOW_DIFF')).length, 2)
  // the first compare and the one at 61 s are inside one ten-minute summary window: one summary line
  assert.equal(lines.filter(line => line.includes('SEAT_VIEW_SHADOW_SUMMARY')).length, 1)
  assert.match(lines.find(line => line.includes('SUMMARY')), /turn=1\/1 own_work=0\/1/)
  assert.deepEqual(shadow.counts.turn, { compared: 3, differed: 3 })
  shadow.compare(data, { structuredContent: { sessions: [{ session_id: 'a' }] } }); shadow.compare(null, null)
  assert.equal(shadow.unavailable, 2)
})

test('pty_list include goes only to an Aiterm whose schema has it, and a failed schema read does not stop the poll', async () => {
  const { AitermClient } = await import('../src/aiterm-client.mjs')
  const run = async tools => {
    const sent = [], client = new AitermClient()
    client.client = { async request() { if (tools === null) throw new Error('tools/list down'); return { tools } }, async callTool(call) { sent.push(call.arguments); return { content: [] } } }
    await client.call('pty_list', { include: ['turn', 'own_work'] }); await client.call('pty_list', { include: ['turn', 'own_work'] })
    return sent
  }
  const withInclude = [{ name: 'pty_list', inputSchema: { properties: { include: { type: 'array' } } } }]
  assert.deepEqual(await run(withInclude), [{ include: ['turn', 'own_work'] }, { include: ['turn', 'own_work'] }])
  assert.deepEqual(await run([{ name: 'pty_list', inputSchema: { properties: {} } }]), [{}, {}])
  assert.deepEqual(await run(null), [{}, {}])
})

test('the switch takes turn, own_work and unread from sessions[], keeps route_since and Codex rows, and leaves an old Aiterm alone', () => {
  const old = (session, extra = {}) => ({ session_id: session, harness: 'claude-code', launch_id: 'l-' + session, route_since: 'r', turn: { state: 'idle' }, own_work: own, ...extra })
  const data = { schema: 'aiterm.seat-turns.v1', seats: [old('a'), old('b'), old('c'), old('x', { harness: 'codex-cli', turn: { ...running, event_cursor: 4, wait_process: 'w' } })], unread: ['u'] }
  const sessions = [{ session_id: 'a', turn: running, own_work: { ...own, tasks: 1 } }, { session_id: 'b', turn: null }, { session_id: 'c' }, { session_id: 'x', turn: { state: 'idle' } }]
  const out = genericSeatData(data, sessions)
  assert.deepEqual(out.seats.map(seat => seat.session_id), ['a', 'c', 'x'])
  assert.deepEqual(out.seats[0].turn, { ...running, event_cursor: null })
  assert.equal(out.seats[0].own_work.tasks, 1)
  assert.equal(out.seats[0].route_since, 'r')
  assert.deepEqual(out.unread.sort(), ['b', 'u'])
  assert.equal(out.seats[1], data.seats[2]) // no turn field for c: Aiterm's row stays
  assert.equal(out.seats[2].turn.wait_process, 'w')
  assert.equal(genericSeatData(data, [{ session_id: 'a' }]), data)
  assert.equal(genericSeatData(undefined, sessions), undefined)
})
