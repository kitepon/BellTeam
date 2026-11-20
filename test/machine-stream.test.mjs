import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MachineStream, project } from '../src/machine-stream.mjs'
import { createSeatRequestApi } from '../src/http-seat-request-api.mjs'
import { createMessageViews } from '../src/http-messages.mjs'
import { listRecent } from '../src/members/profiles-http.mjs'
import { recentTimeline } from '../src/timeline-index.mjs'
import { ConversationStore } from '../src/conversation-store.mjs'
import { SelfTurns } from '../src/self-turns.mjs'
import { validateConversationCallback, normalizeConversationCallback } from '../src/conversation/callbacks.mjs'
import { validateConversationEffectResult } from '../src/conversation/effects.mjs'

const bots = new Map([['bot-d', { id: 'bot-d', name: 'ドリリー' }]])
const J = value => JSON.stringify(value)
const ask = (id, questions) => J({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions } } })
const Q = [{ header: 'H', question: 'Which?', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B' }] }]
const pending = (...ids) => ({ state: 'blocked', reason: null, pending: ids.map(request_id => ({ request_id, subtype: 'can_use_tool', tool_name: 'AskUserQuestion' })) })
const env = (lines, from, after, state = { state: 'busy', reason: null, pending: [] }, launch = 'L1') =>
  ({ botId: 'bot-d', session: 's1', launch_id: launch, cursor_from: from, cursor_after: after, lines, state })

async function service(t, streamSend = async () => ({ accepted: true })) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-machine-stream-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const requested = [], changes = [], sent = []
  const make = () => new MachineStream({ root, bots, streamSend: async (id, input) => { sent.push([id, input]); return streamSend(id, input) }, onRequest: item => requested.push(item.id), now: () => '2026-11-20T00:00:00.000Z' })
  const ms = make(); await ms.initialize(); ms.watch(change => changes.push(change))
  return { ms, root, requested, changes, sent, make }
}

test('project: every kind has a view; unknown and non-JSON are shown, never dropped', () => {
  const views = line => project(typeof line === 'string' ? line : J(line)).map(p => p.view)
  assert.deepEqual(views({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }), ['thinking', 'words', 'tool_use'])
  assert.deepEqual(views({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out' }] } }), ['tool_result'])
  assert.deepEqual(views({ type: 'system', subtype: 'init' }), ['system'])
  assert.deepEqual(views({ type: 'system', subtype: 'hook_response' }), ['hook'])
  assert.deepEqual(views({ type: 'result', subtype: 'success' }), ['result'])
  assert.deepEqual(views({ type: 'rate_limit_event' }), ['rate_limit'])
  assert.deepEqual(views({ type: 'stream_event' }), ['control'])
  assert.deepEqual(views({ type: 'control_request', request_id: 'r', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } }), ['approval'])
  assert.deepEqual(views({ type: 'something_new', x: 1 }), ['unknown'])
  assert.deepEqual(views('not json {'), ['unknown'])
  assert.deepEqual(views({ type: 'assistant', message: { content: [{ type: 'future_block' }] } }), ['unknown'])
  assert.deepEqual(views(ask('r', [{ question: '', options: [] }])), ['unknown'])
})

test('ingest: stores raw lines, advances the cursor, resyncs on a gap or replay, starts a new segment on a new launch', async t => {
  const { ms, root, changes, make } = await service(t)
  assert.equal(ms.cursor('bot-d'), null)
  const first = ['{"type":"system","subtype":"init"}', '{"type":"mystery"}']
  assert.deepEqual(await ms.ingest(env(first, null, 'L1:100')), { status: 'stored', cursor: 'L1:100' })
  assert.deepEqual(ms.cursor('bot-d'), { session: 's1', launch_id: 'L1', cursor: 'L1:100' })
  assert.deepEqual(changes.at(-1), { all: false, topics: ['timeline'], botIds: ['bot-d'], roomIds: [] })
  assert.deepEqual(await ms.ingest(env(first, null, 'L1:100')), { status: 'resync', cursor: 'L1:100' }) // replay
  assert.deepEqual(await ms.ingest(env(['{"type":"x"}'], 'L1:999', 'L1:1000')), { status: 'resync', cursor: 'L1:100' }) // gap
  assert.deepEqual(await ms.ingest(env(['{"type":"x"}'], 'L1:100', 'L1:150')), { status: 'stored', cursor: 'L1:150' })
  assert.deepEqual(await ms.ingest(env([], 'L1:150', 'L1:150')), { status: 'stored', cursor: 'L1:150' }) // idle poll writes nothing
  assert.deepEqual(await ms.ingest(env(['{"type":"y"}'], null, 'L2:10', undefined, 'L2')), { status: 'stored', cursor: 'L2:10' }) // new launch
  assert.equal(ms.line('bot-d', 2).line, '{"type":"mystery"}')
  // unknown kind is in the log (visible), init is stored but hidden by the rule table
  assert.deepEqual(ms.timeline({ botId: 'bot-d' }).map(r => r.machine_event.view), ['system', 'unknown', 'unknown', 'unknown'])
  assert.equal(ms.timelineView({ botId: 'bot-d' }, { all: true }).length, 4)
  assert.deepEqual(ms.timeline({ roomId: 'room-x' }), [])
  await assert.rejects(ms.ingest({ ...env([], null, 'x'), botId: 'bot-zz' }), { code: 'MACHINE_STREAM_INVALID' })
  // restart: the cursor and the entries come back from the log; a torn tail batch is cut
  await appendFile(join(root, 'state/machine-stream/bot-d.jsonl'), J({ seq: 99, type: 'line', at: 'x', session: 's1', launch_id: 'L2', cursor_after: null, line: '{}' }) + '\n{"seq":100,"ty')
  const again = make(); await again.initialize()
  assert.deepEqual(again.cursor('bot-d'), { session: 's1', launch_id: 'L2', cursor: 'L2:10' })
  assert.equal(again.timelineView({ botId: 'bot-d' }, { all: true }).length, 4)
})

test('default table shows every kind, folds tool results and empty thinking, hides nothing; the table is read at display time and stored data does not change', async t => {
  const { ms, root } = await service(t)
  const lines = [J({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'I am checking' }, { type: 'thinking', thinking: '' }, { type: 'text', text: 'answer' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }),
    J({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a\nb' }] } }), J({ type: 'result', subtype: 'success' }), J({ type: 'result', subtype: 'error_during_execution' })]
  await ms.ingest(env(lines, null, 'L1:1'))
  const shown = ms.timeline({ botId: 'bot-d' }).map(r => [r.machine_event.view, r.machine_event.display])
  assert.deepEqual(shown, [['thinking', 'show'], ['thinking', 'fold'], ['words', 'show'], ['tool_use', 'show'], ['tool_result', 'fold'], ['result', 'fold'], ['result', 'show']])
  assert.equal(ms.timeline({ botId: 'bot-d' })[1].message, 'thinking (no text)') // an empty thinking block is a folded line, never removed
  const before = await readFile(join(root, 'state/machine-stream/bot-d.jsonl'), 'utf8')
  const hidden = new MachineStream({ root, bots, streamSend: async () => ({}), rules: { ...(await import('../src/machine-display-rules.json', { with: { type: 'json' } })).default, thinking: 'hide', tool_use: 'fold', refine: [] } })
  await hidden.initialize({ readOnly: true })
  assert.deepEqual(hidden.timeline({ botId: 'bot-d' }).slice(0, 4).map(r => r.machine_event.display), ['show', 'show', 'show', 'fold']) // same data, another table; a 'hide' in a table shows (there is no hide)
  assert.equal(await readFile(join(root, 'state/machine-stream/bot-d.jsonl'), 'utf8'), before)
})

test("Tronie's default table: what is shown open and what is folded to one line", async t => {
  const { ms } = await service(t)
  const cases = [
    [{ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }, 'show'],
    [{ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'why' }] } }, 'show'],
    [{ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }] } }, 'fold', 'thinking (no text)'],
    [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }, 'show'],
    [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] } }, 'fold'],
    [{ type: 'user', message: { content: [{ type: 'text', text: 'replayed bubble' }] } }, 'fold'],
    [{ type: 'system', subtype: 'init', model: 'claude-x', tools: ['a', 'b', 'c'] }, 'fold', 'start: claude-x, 3 tools'],
    [{ type: 'system', subtype: 'hook_started', hook_name: 'Stop' }, 'fold'],
    [{ type: 'system', subtype: 'hook_response' }, 'fold'],
    [{ type: 'system', subtype: 'api_retry' }, 'fold'],
    [{ type: 'system', subtype: 'api_error', error: 'overloaded' }, 'show'],
    [{ type: 'system', subtype: 'command_lifecycle' }, 'fold'],
    [{ type: 'result', subtype: 'success', duration_ms: 12345 }, 'fold', 'done: 12.3s'],
    [{ type: 'result', subtype: 'error_during_execution' }, 'show'],
    [{ type: 'result', subtype: 'success', is_error: true }, 'show'],
    [{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }, 'fold'],
    [{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } }, 'fold'],
    [{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }, 'show'],
    [{ type: 'control_response', response: { subtype: 'success', request_id: 'cfg' } }, 'fold'],
    [{ type: 'control_cancel_request', request_id: 'zz' }, 'fold'],
    [{ type: 'brand_new_kind' }, 'fold', 'brand_new_kind'],
    [JSON.parse(ask('q', Q)), 'show'],
    [{ type: 'control_request', request_id: 'ap', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: 'p' } } }, 'show'],
  ]
  await ms.ingest(env(cases.map(([line]) => J(line)), null, 'L1:1', pending('q', 'ap')))
  const rows = ms.timeline({ botId: 'bot-d' })
  assert.deepEqual(rows.map(r => r.machine_event.display), cases.map(c => c[1]))
  cases.forEach(([, , title], i) => { if (title) assert.equal(rows[i].machine_event.title, title) })
  assert.ok(rows.every(r => r.machine_event.display === 'show' || r.machine_event.fold_group), 'folded rows carry fold_group for optional same-kind grouping')
})

test('question card: pending, answer builds the control_response, answered only after Aiterm took it', async t => {
  const { ms, requested, sent } = await service(t)
  await ms.ingest(env([ask('r1', Q)], null, 'L1:1', pending('r1')))
  assert.deepEqual(requested, ['r1'])
  const row = ms.timeline({ botId: 'bot-d' }).at(-1)
  assert.deepEqual([row.machine_event.view, row.machine_event.display, row.machine_event.request.status], ['question', 'show', 'pending'])
  assert.equal(row.machine_event.request.questions[0].allowOther, true)
  for (const bad of [{}, { answers: [] }, { answers: [{ indexes: [3] }] }, { answers: [{ indexes: [1, 2] }] }, { answers: [{ indexes: [] }] }, { answers: [{ indexes: [1], other: 'x' }] }])
    await assert.rejects(ms.answer('r1', bad), { code: 'SEAT_REQUEST_ANSWER_INVALID' })
  assert.deepEqual(sent, [])
  const done = await ms.answer('r1', { answers: [{ indexes: [2] }] })
  assert.equal(done.status, 'answered')
  assert.deepEqual(sent, [['bot-d', { lines: [{ type: 'control_response', response: { subtype: 'success', request_id: 'r1',
    response: { behavior: 'allow', updatedInput: { questions: Q, answers: { 'Which?': 'B' } } } } }] }]])
  assert.equal(ms.timeline({ botId: 'bot-d' }).at(-1).machine_event.request.status, 'answered')
  await assert.rejects(ms.answer('r1', { answers: [{ indexes: [1] }] }), { code: 'SEAT_REQUEST_CLOSED' })
  await assert.rejects(ms.answer('nope', {}), { code: 'SEAT_REQUEST_NOT_FOUND' })
})

test('multiSelect and Other build the value joined with ", "; approval cards take allow / deny', async t => {
  const { ms, sent } = await service(t)
  const multi = [{ question: 'Pick', multiSelect: true, options: [{ label: 'Apple' }, { label: 'Banana' }] }]
  await ms.ingest(env([ask('m1', multi), J({ type: 'control_request', request_id: 'a1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } })], null, 'L1:1', pending('m1', 'a1')))
  await ms.answer('m1', { answers: [{ indexes: [1, 2], other: ' Cherry ' }] })
  assert.equal(sent[0][1].lines[0].response.response.updatedInput.answers.Pick, 'Apple, Banana, Cherry')
  await assert.rejects(ms.answer('a1', { decision: 'maybe' }), { code: 'SEAT_REQUEST_ANSWER_INVALID' })
  await ms.answer('a1', { decision: 'deny' })
  assert.deepEqual(sent[1][1].lines[0].response.response, { behavior: 'deny', message: 'Denied by the Owner' })
})

test('a request leaves pending by cancel, by state.pending, by exit, or by REQUEST_NOT_PENDING; other failures keep it pending', async t => {
  let failure = null
  const { ms } = await service(t, async () => { throw failure })
  await ms.ingest(env([ask('c1', Q), ask('c2', Q), ask('c3', Q), ask('c4', Q)], null, 'L1:1', pending('c1', 'c2', 'c3', 'c4')))
  await ms.ingest(env([J({ type: 'control_cancel_request', request_id: 'c1' })], 'L1:1', 'L1:2', pending('c2', 'c3', 'c4')))
  assert.equal(ms.get('c1').status, 'expired')
  await ms.ingest(env([], 'L1:2', 'L1:2', pending('c3', 'c4')))
  assert.equal(ms.get('c2').status, 'expired') // no longer in state.pending
  failure = Object.assign(new Error('x'), { code: 'STREAM_SEND_FAILED' })
  await assert.rejects(ms.answer('c3', { answers: [{ indexes: [1] }] }), { code: 'STREAM_SEND_FAILED' })
  assert.equal(ms.get('c3').status, 'pending')
  failure = Object.assign(new Error('x'), { code: 'STREAM_REQUEST_NOT_PENDING' })
  await assert.rejects(ms.answer('c3', { answers: [{ indexes: [1] }] }), { code: 'REQUEST_NOT_PENDING' })
  assert.equal(ms.get('c3').status, 'expired')
  await ms.ingest(env([], 'L1:2', 'L1:2', { state: 'exited', reason: null, pending: [] }))
  assert.equal(ms.get('c4').status, 'expired')
  // a request opened and already gone in the same envelope is expired too
  await ms.ingest(env([ask('c5', Q)], 'L1:2', 'L1:3', { state: 'idle', reason: null, pending: [] }))
  assert.equal(ms.get('c5').status, 'expired')
})

test('views merge the machine source only when the Bot has entries; route is Owner-only', async t => {
  const { ms } = await service(t)
  const views = createMessageViews({ rooms: {}, store: { timeline: async () => [] }, machineStream: ms })
  assert.deepEqual((await views.timeline('bots', 'bot-d')).map(e => e.kind), [])
  await ms.ingest(env([ask('r1', Q)], null, 'L1:1', pending('r1')))
  assert.deepEqual((await views.timeline('bots', 'bot-d')).map(e => e.kind), ['machine_event'])
  const call = async (api, { method = 'POST', path = '/api/seat-requests/r1/answer', body = { answers: [{ indexes: [1] }] } } = {}) => {
    const out = {}
    const request = Object.assign((async function* () { yield Buffer.from(J(body)) })(), { method })
    const response = { writeHead(code) { out.code = code }, end(data) { out.body = JSON.parse(data) } }
    out.handled = await api(request, response, new URL(path, 'http://x'))
    return out
  }
  assert.equal((await call(createSeatRequestApi({ machineStream: ms, internal: true }))).code, 403)
  const api = createSeatRequestApi({ machineStream: ms, internal: false })
  assert.equal((await call(api, { path: '/api/other' })).handled, false)
  assert.equal((await call(api, { body: { answers: [{ indexes: [9] }] } })).code, 400)
  assert.equal((await call(api, { path: '/api/seat-requests/none/answer' })).code, 404)
  assert.equal((await call(api, { method: 'GET', path: '/api/bots/bot-d/machine-events/1' })).body.line, ask('r1', Q))
  assert.equal((await call(api, { method: 'GET', path: '/api/bots/bot-d/machine-events/99' })).code, 404)
  const ok = await call(api)
  assert.deepEqual([ok.code, ok.body.request.status], [200, 'answered'])
  assert.equal((await call(api)).code, 409)
})

test('chat from the stream: the saved final answer is kept but not drawn; stream rows are quotable and forwardable', async t => {
  const { ms, root } = await service(t)
  await ms.ingest(env([J({ type: 'assistant', message: { content: [{ type: 'text', text: 'the words' }] } })], null, 'L1:1'))
  const logPath = join(root, 'direct.jsonl')
  const record = (id, from, target, message, extra = {}) => ({ schema: 'bellteam.direct-message.v1', delivery_id: id, at: '2026-11-20T00:00:0' + id.length + '.000Z', from, target,
    from_identity: { id: from, name: from, position: '', role: '' }, target_identity: { id: target, name: target, position: '', role: '' }, message, image: false, delivery: 'delivered', ...extra })
  await appendFile(logPath, [record('q1', 'user', 'bot-d', 'question'), record('a1', 'bot-d', 'user', 'the words', { stream: true }), record('n11', 'bot-d', 'user', 'a note from the Bot (sendmessage)')].map(J).join('\n') + '\n')
  const store = new ConversationStore({ logPath, machineRow: async (botId, id) => ms.rowSource(botId, id) })
  assert.deepEqual((await store.timeline('bot-d')).map(item => item.id), ['q1', 'n11']) // the stream:true answer row is not drawn
  assert.equal((await store.records()).length, 3) // still in the log
  const quote = await store.quoteSource('bot-d', 'me-1-0')
  assert.deepEqual([quote.text, quote.sender.id, quote.image], ['the words', 'bot-d', false])
  assert.deepEqual((await store.forwardSource('bot-d', 'me-1-0')).imageAssets, [])
  assert.equal(await store.quoteSource('bot-d', 'me-9-0'), null)
  assert.equal(ms.rowSource('bot-d', 'me-1-0').text, 'the words')
})

test('user.complete may carry stream:true; shown.read may carry stream:true; a machine seat self-started answer is not written but consumed', async () => {
  validateConversationCallback('user.complete', { reply: 'x', stream: true })
  assert.deepEqual(normalizeConversationCallback('user.complete', { reply: 'x', stream: true }), { reply: 'x', stream: true })
  assert.throws(() => validateConversationCallback('user.complete', { reply: 'x', stream: false }))
  validateConversationEffectResult('execution.shown.read', { shownId: 's', words: [], endedAt: null, stream: true })
  assert.throws(() => validateConversationEffectResult('execution.shown.read', { shownId: 's', words: [], endedAt: null, stream: 'yes' }))
  const appended = [], consumed = []
  const selfTurns = new SelfTurns({ bots, statePath: '/nonexistent/self.json', appendAnswer: async (...a) => appended.push(a), shown: async () => ({ words: ['w'], endedAt: null, stream: true }),
    consumeShown: async (...a) => consumed.push(a) })
  selfTurns.assertCurrent = () => {}; selfTurns.startedOutsideDelivery = async () => true
  const current = { seen: [], lastCompletedAt: null }
  await selfTurns.accept(bots.get('bot-d'), current, { source_sha256: 'k', assistant: 'self answer', completed_at: 1 }, null)
  assert.deepEqual([appended.length, consumed.length, current.seen], [0, 1, ['k']])
})

test('Bot list preview follows the stream rows the chat draws open, not folded ones', async t => {
  const { ms } = await service(t)
  const views = createMessageViews({ rooms: {}, store: { timeline: async () => [{ id: 'q1', kind: 'message', direction: 'outgoing', message: 'question', at: '2026-11-19T00:00:00.000Z' }] }, machineStream: ms })
  const last = async () => recentTimeline(await views.sources('bots', 'bot-d', null, true))
  assert.equal((await last()).id, 'q1') // nothing from the stream yet
  await ms.ingest(env([J({ type: 'assistant', message: { content: [{ type: 'text', text: 'first line\nsecond' }] } }), J({ type: 'result', subtype: 'success', duration_ms: 1000 }), J({ type: 'system', subtype: 'hook_response' })], null, 'L1:1'))
  const preview = listRecent(await last())
  assert.deepEqual([preview.kind, preview.direction, preview.message, preview.image], ['message', 'incoming', 'first line', false]) // the folded result and hook rows do not become the preview
  assert.equal(listRecent({ id: 'q1', kind: 'message', direction: 'outgoing', message: 'm', image: false, at: 'a' }).direction, 'outgoing')
})
