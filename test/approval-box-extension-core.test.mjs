import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyOrigin, toViewDecision, summarize } from '../src/approval-box-extension/origin-view.mjs'
import { entitlementFrom, cacheMillis } from '../src/approval-box-extension/entitlement.mjs'
import { nextConnect } from '../src/approval-box-extension/connect-state.mjs'
import { planLink, targetChart, taskIdOf, attachTarget } from '../src/approval-box-extension/link-plan.mjs'

const roster = [{ id: 'bot-823b56e9', name: 'ブレッディ' }]
const decision = (extra = {}) => ({ id: 'K-1', title: '請求を同じにするか', context: '', options: [{ id: 'o1', label: '同じにする' }, { id: 'o2', label: '別にする' }], recommendation: 'o1', urgency: 'high',
  status: 'pending', version: 1, created_at: '2026-11-15T01:00:00Z', updated_at: '2026-11-15T01:00:00Z', resume_phrase: 'x', history: [{ at: 't', kind: 'created', by: 'ai' }],
  source: { client: 'claude-code', session_label: 'ブレッディ / billing', requester: 'ブレッディ', requester_bot_id: 'bot-823b56e9', via: 'connector' }, ...extra })

test('origin: bot id, then roster name, then external, then unknown; nothing is hidden', () => {
  assert.deepEqual(classifyOrigin(decision().source, roster).origin.basis, 'botId')
  assert.equal(classifyOrigin({ client: 'codex', requester: 'ブレッディ' }, roster).origin.basis, 'name')
  const external = classifyOrigin({ client: 'cursor', session_label: 'Mac / receipts', requester: '他社のAI' }, roster)
  assert.equal(external.origin.kind, 'external'); assert.equal(external.requester, null); assert.equal(external.origin.tool, 'Cursor')
  assert.equal(classifyOrigin({}, roster).origin.kind, 'unknown')
  assert.equal(classifyOrigin({ client: 'x-new', session_label: 's' }, roster).origin.client, 'other')
})

test('ViewDecision: recommended, amended, answer and attachments map; summary counts every origin', () => {
  const amended = decision({ version: 2, history: [{ at: 'a', kind: 'created', by: 'ai' }, { at: 'b', kind: 'amended', by: 'ai', fields: ['options'] }] })
  const view = toViewDecision(amended, { roster })
  assert.equal(view.options[0].recommended, true); assert.deepEqual(view.amended, { is: true, fields: ['options'], note: null, at: 'b' }); assert.equal(view.requester.name, 'ブレッディ')
  const answered = toViewDecision(decision({ status: 'answered', answer: { option_id: 'o2', answered_at: 'z', attachments: [] }, delivery: 'unknown' }), { roster })
  assert.equal(answered.answer.optionId, 'o2'); assert.equal(answered.delivery, 'unknown')
  const outside = decision({ id: 'K-2', source: { client: 'chatgpt', session_label: 'x' } })
  assert.deepEqual(summarize([decision(), outside, decision({ id: 'K-3', status: 'held' })], { roster }), { schema: 'bellteam.approvals-summary.v1', pending: 2, urgent: 2, held: 1, answeredToday: 0, filedToday: 0, byOrigin: { bellteam: 1, external: 1 } })
})

test('entitlement: trial and billing-off are entitled (Owner decision d); expired, revoked, none are not; unknown never locks', () => {
  const now = Date.parse('2026-11-15T00:00:00Z'), future = '2027-01-01T00:00:00Z', past = '2026-10-01T00:00:00Z'
  const at = (me, extra) => entitlementFrom(me, { now, ...extra })
  assert.equal(at({ plan: 'active', expires_at: future, billing: 'store', store: 'app_store' }).state, 'paid')
  assert.equal(at({ plan: 'trial', billing: 'store' }).entitled, true)
  assert.equal(at({ plan: 'active', billing: 'off' }).state, 'paid')
  assert.equal(at({ plan: 'expired', expires_at: past }).entitled, false)
  assert.equal(at({ plan: 'expired', expires_at: future }).state, 'revoked')
  assert.equal(at({}).state, 'none'); assert.equal(at({ plan: 'active' }, { credential: false }).entitled, false)
  const known = at({ plan: 'active', expires_at: future })
  assert.equal(at(null, { reachable: false, previous: known }), known)
  assert.equal(at(null, { reachable: false }).entitled, true)
  assert.equal(at({ plan: 'active', billing: 'store' }).state, 'paid') // billing-exempt account: no expires_at, no store
  assert.equal(at({ plan: 'active', expires_at: past, billing: 'store' }, { previous: known }).state, 'unknown')
  assert.equal(cacheMillis(known), 300_000); assert.equal(cacheMillis(at({})), 60_000)
})

test('connect state: long poll loops on waiting; every state leaves', () => {
  assert.deepEqual(nextConnect('not_connected', { type: 'start' }), { state: 'waiting', again: true })
  assert.deepEqual(nextConnect('waiting', { type: 'poll', status: 'waiting' }), { state: 'waiting', again: true, startNew: false })
  assert.equal(nextConnect('waiting', { type: 'poll', status: 'claimed' }).state, 'connected')
  assert.equal(nextConnect('waiting', { type: 'poll', status: 'rejected' }).state, 'denied')
  assert.equal(nextConnect('waiting', { type: 'poll', status: 'delivered' }).startNew, true)
  assert.equal(nextConnect('waiting', { type: 'cancel' }).state, 'not_connected')
  assert.equal(nextConnect('connected', { type: 'unauthorized' }).state, 'expired')
  assert.equal(nextConnect('expired', { type: 'start' }).state, 'waiting')
  assert.equal(nextConnect('denied', { type: 'start' }).state, 'waiting')
  assert.equal(nextConnect('connected', { type: 'poll', status: 'waiting' }).state, 'connected') // a stray poll never moves a connected state
})

const view = (extra = {}, source = decision().source) => toViewDecision(decision({ source, ...extra }), { roster })
const chart = (cards = [], edges = []) => ({ projectId: 'bellteam', cards, edges })
const kinds = plan => plan.actions.map(a => a.op === 'ownerTask' ? a.args.slice(0, 2).join(' ') : a.op)

test('L9: an external decision causes no chart action and no row', () => {
  const plan = planLink({ d: view({}, { client: 'cursor', session_label: 'Mac / receipts' }), row: null, chart: chart() })
  assert.deepEqual(plan, { actions: [], row: null })
})

test('L1: a BellTeam decision links first, ensures the plan, then adds one approval-box-lane task', () => {
  const plan = planLink({ d: view(), row: null, chart: chart() })
  assert.deepEqual(kinds(plan), ['link', 'ensurePlan', 'todo add'])
  assert.equal(plan.actions[0].taskId, 'dec-k-1')
  const add = plan.actions[2].args
  assert.equal(add[add.indexOf('--lane') + 1], 'approval-box'); assert.ok(!add.includes('--after'))
  assert.equal(plan.row.state, 'linked')
  assert.deepEqual(planLink({ d: view(), row: plan.row, chart: chart([{ id: 'approval-box/dec-k-1', plan: 'approval-box', taskId: 'dec-k-1', state: 'ready', lane: 'approval-box' }]) }).actions, []) // replay is quiet
})

test('L2: answered -> start then done; an in-progress card only gets done; a done card gets nothing', () => {
  const row = { decisionId: 'K-1', projectId: 'bellteam', plan: 'approval-box', taskId: 'dec-k-1', state: 'linked', attached: false, sessionLabel: 's', handledVersion: 1 }
  const answered = view({ status: 'answered', version: 2, answer: { option_id: 'o1', answered_at: '2026-11-15T01:30:00Z' } })
  const card = state => chart([{ id: 'approval-box/dec-k-1', plan: 'approval-box', taskId: 'dec-k-1', state, lane: 'approval-box' }])
  const ready = planLink({ d: answered, row, chart: card('ready') })
  assert.deepEqual(kinds(ready), ['todo start', 'todo done']); assert.equal(ready.row.state, 'answered')
  assert.match(ready.actions[1].args.at(-1), /同じにする.*11月15日 10:30/u)
  assert.deepEqual(kinds(planLink({ d: answered, row, chart: card('in-progress') })), ['todo done'])
  assert.deepEqual(planLink({ d: answered, row, chart: card('done') }).actions, [])
})

test('L3/L4/L6: cancel retires, amend notes, a card closed by hand is only marked diverged', () => {
  const row = { decisionId: 'K-1', projectId: 'bellteam', plan: 'approval-box', taskId: 'dec-k-1', state: 'linked', attached: false, sessionLabel: 's', handledVersion: 1 }
  const card = state => chart([{ id: 'approval-box/dec-k-1', plan: 'approval-box', taskId: 'dec-k-1', state, lane: 'approval-box' }])
  assert.deepEqual(kinds(planLink({ d: view({ status: 'cancelled', cancel_reason: '統合した' }), row, chart: card('ready') })), ['todo retire'])
  const amended = view({ version: 2, history: [{ at: 'b', kind: 'amended', by: 'ai', fields: ['options'] }] })
  const noted = planLink({ d: amended, row, chart: card('ready') })
  assert.deepEqual(kinds(noted), ['todo note']); assert.equal(noted.row.handledVersion, 2)
  const diverged = planLink({ d: view(), row, chart: card('done') })
  assert.deepEqual(diverged.actions, []); assert.equal(diverged.row.state, 'diverged')
})

test('L7: a new decision of the same session is inserted after the answered one and before its unfinished successors', () => {
  const answeredRow = { decisionId: 'K-0', projectId: 'bellteam', plan: 'approval-box', taskId: 'dec-k-0', state: 'answered', attached: false, sessionLabel: 'ブレッディ / billing', handledVersion: 2 }
  const c = chart([{ id: 'approval-box/dec-k-0', plan: 'approval-box', taskId: 'dec-k-0', state: 'done', lane: 'approval-box' }, { id: 'p/impl', plan: 'p', taskId: 'impl', state: 'pending', lane: 'bot-823b56e9' }],
    [{ from: 'approval-box/dec-k-0', to: 'p/impl' }])
  const plan = planLink({ d: view(), row: null, rows: [answeredRow], chart: c })
  const add = plan.actions.find(a => a.args?.[1] === 'add').args
  assert.equal(add[add.indexOf('--after') + 1], 'dec-k-0')
  assert.deepEqual(plan.actions.filter(a => a.args?.[1] === 'predecessor').map(a => a.args[2]), ['add', 'remove'])
})

test('L8/L10: a decision naming a chart task attaches to it (never creates), kind does not matter; a missing card, or one outside lane approval-box (owner included), waits', () => {
  const src = { client: 'claude-code', session_label: 'ブレッディ / Lattice bellteam a1/t07', requester: 'ブレッディ' }
  const card = lane => chart([{ id: 'a1/t07', plan: 'a1', taskId: 't07', state: 'ready', lane }])
  const plan = planLink({ d: view({}, src), row: null, chart: card('approval-box') })
  assert.deepEqual(kinds(plan), ['link']); assert.equal(plan.row.attached, true)
  assert.deepEqual(planLink({ d: view({}, src), row: null, chart: card('bot-1') }).actions, [])
  assert.deepEqual(planLink({ d: view({}, src), row: null, chart: card('owner') }).actions, [])
  assert.deepEqual(attachTarget('Lattice bellteam a1/t07'), { projectId: 'bellteam', plan: 'a1', taskId: 't07' })
})

test('rule T: the named chart, else the requester Bot chart, else the coordinator chart', () => {
  const charts = [{ projectId: 'bellteam', createdBy: 'bot-7b140b27', coordinator: true }, { projectId: 'billing', createdBy: 'bot-823b56e9', coordinator: false }]
  assert.equal(targetChart(view(), charts), 'billing')
  assert.equal(targetChart(view({}, { client: 'codex', requester: 'ブレッディ' }), [charts[0]]), 'bellteam')
  assert.equal(targetChart(view({}, { ...decision().source, session_label: 'Lattice bellteam a/b' }), charts), 'bellteam')
  assert.equal(taskIdOf('K-1A2'), 'dec-k-1a2')
})

test('L3: a dec-* task made by L1 is retired when its request is cancelled; an attached task is not (a withdrawn request is not the end of the work)', async () => {
  const { planLink } = await import('../src/approval-box-extension/link-plan.mjs')
  const d = view({ status: 'cancelled', cancel_reason: 'x' })
  const chart = { projectId: 'bellteam', cards: [{ id: 'approval-box/dec-k-aaaa', plan: 'approval-box', taskId: 'dec-k-aaaa', state: 'in-progress', lane: 'approval-box', title: 't' }, { id: 'p1/t1', plan: 'p1', taskId: 't1', state: 'ready', lane: 'approval-box', title: 't' }], edges: [] }
  const row = (plan, taskId, attached) => ({ decisionId: d.id, projectId: 'bellteam', plan, taskId, state: 'linked', attached, handledVersion: 1 })
  assert.ok(planLink({ d, row: row('approval-box', 'dec-k-aaaa', false), rows: [], chart }).actions.some(action => action.args?.includes('retire')))
  const attached = planLink({ d, row: row('p1', 't1', true), rows: [], chart })
  assert.deepEqual(attached.actions, [])
  assert.equal(attached.row.state, 'closed')
})
