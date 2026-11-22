import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { createApprovalBoxExtensionCore } from '../src/approval-box-extension/core.mjs'
import { createApprovalsApi } from '../src/approval-box-extension/http-api.mjs'
import { createApprovalsDispatcher } from '../src/approval-box-extension-dispatcher.mjs'
import { validateApprovalsRequest, validateApprovalsEffect, validateApprovalsEffectResult, validateApprovalsResult, approvalsWireError } from '../src/approval-box-extension-protocol.mjs'
import { planLink } from '../src/approval-box-extension/link-plan.mjs'

const ME = { plan: 'active', expires_at: '2099-01-01T00:00:00Z', billing: 'store', store: 'app_store' }
const raw = (id, extra = {}) => ({ id, title: '請求を同じにするか', context: '', options: [{ id: 'o1', label: '同じにする' }, { id: 'o2', label: '別にする' }], recommendation: 'o1', urgency: 'normal',
  status: 'pending', version: 1, created_at: '2026-11-15T01:00:00Z', updated_at: '2026-11-15T01:00:00Z', resume_phrase: 'x', history: [],
  source: { client: 'claude-code', session_label: 'ブレッディ / billing', requester: 'ブレッディ', requester_bot_id: 'bot-823b56e9', via: 'connector' }, ...extra })

// A fake Approval Box + a fake parent. calls records every effect; `server` answers /v1 paths.
function harness({ decisions = [], session = { token: 'kss_x', expiresAt: null }, cards = [], me = ME, pairing = null, rowsText = null, daemon = null } = {}) {
  const calls = [], writes = new Map(), box = { decisions: new Map(decisions.map(d => [d.id, d])), me, hits: [] }
  let stored = session && JSON.stringify(session)
  const client = {
    async call(token, method, path, options = {}) {
      box.hits.push(`${method} ${path}`)
      if (token !== 'kss_x' && token !== 'kss_new') return { status: 401, json: null }
      if (path === '/v1/me') return { status: 200, json: box.me }
      if (path.startsWith('/v1/decisions?')) return { status: 200, json: { items: [...box.decisions.values()].filter(d => path.includes(d.status) || path.includes('pending,held') && ['pending', 'held'].includes(d.status)) } }
      const m = /^\/v1\/decisions\/([^/]+)(?:\/(answer|hold|unhold))?$/u.exec(path)
      const d = m && box.decisions.get(m[1])
      if (!d) return { status: 404, json: null }
      if (m[2] === 'answer') {
        if (options.json.version !== d.version) return { status: 409, json: { error: { code: 'conflict', decision: d } } }
        Object.assign(d, { status: 'answered', answer: { option_id: options.json.option_id, answered_at: '2026-11-15T02:00:00Z' }, version: d.version + 1 })
      }
      return { status: 200, json: d }
    },
    startPairing: async () => ({ pairing_id: 'p1', code: 'C', qr_url: 'https://approval-box.kitepon.dev/pair?c=C', poll_secret: 's', expires_at: '2099-01-01T00:00:00Z' }),
    pollPairing: async () => pairing ?? { status: 'waiting' },
    async *events() { await new Promise(() => {}) },
  }
  const chartCards = cards
  const effect = async (method, params) => {
    calls.push([method, params])
    if (method === 'session.get') return stored ? { value: stored } : null
    if (method === 'session.put') { stored = params.value; return { ok: true } }
    if (method === 'session.erase') { stored = null; return { ok: true } }
    if (method === 'daemon.decisions.list') { if (!daemon) throw new Error('unexpected effect'); return [...daemon.keys()].map(id => ({ id })) } // a490g: the hosted daemon's list
    if (method === 'daemon.decisions.read') { if (!daemon) throw new Error('unexpected effect'); return daemon.get(params.id) ?? null }
    if (method === 'members.list') return [{ id: 'bot-823b56e9', name: 'ブレッディ' }]
    if (method === 'lattice.charts') return [{ projectId: 'bellteam', name: 'BellTeam開発', createdBy: 'bot-7b140b27', coordinator: true }]
    if (method === 'lattice.chart') return { cards: chartCards, edges: [] }
    if (method === 'lattice.link') return { schema: 'bellteam.lattice-link.v1', ...params, linked: true }
    if (method === 'lattice.ownerTask') { writes.set(params.args.join(' '), params); return { exitCode: 0, result: {}, stdout: null, stderr: '' } }
    throw new Error(`unexpected effect ${method}`)
  }
  const core = createApprovalBoxExtensionCore({ client, now: () => Date.parse('2026-11-15T03:00:00Z'), files: { read: async () => rowsText, write: async () => {} }, streamBackoffMs: 5 })
  return { core, effect, calls, writes, box, stored: () => stored }
}

test('gate: no session answers not_connected, a plan-less account not_entitled; trial is entitled', async () => {
  const none = harness({ session: null })
  await assert.rejects(() => none.core.list({ status: ['pending'] }, none.effect), { code: 'APPROVALS_NOT_CONNECTED' })
  assert.equal((await none.core.connection({}, none.effect)).state, 'not_connected')
  const planless = harness({ me: {} })
  await assert.rejects(() => planless.core.summary({}, planless.effect), { code: 'APPROVALS_NOT_ENTITLED' })
  const trial = harness({ me: { plan: 'trial', billing: 'store' }, decisions: [raw('K-AAAA')] })
  assert.equal((await trial.core.list({ status: ['pending'] }, trial.effect)).items.length, 1)
})

test('connection never calls the network (the exchange probe)', async () => {
  const h = harness({ decisions: [raw('K-AAAA')] })
  const value = await h.core.connection({}, h.effect)
  assert.equal(value.state, 'connected'); assert.deepEqual(h.box.hits, [])
})

test('list: BellTeam and external decisions are both returned; the origin filter narrows only when asked', async () => {
  const outside = raw('K-BBBB', { source: { client: 'cursor', session_label: 'Mac / receipts' } })
  const h = harness({ decisions: [raw('K-AAAA'), outside] })
  const all = await h.core.list({ status: ['pending'] }, h.effect)
  assert.deepEqual(all.items.map(item => item.origin.kind).sort(), ['bellteam', 'external'])
  assert.deepEqual((await h.core.list({ status: ['pending'], origin: 'external' }, h.effect)).items.map(item => item.id), ['K-BBBB'])
  assert.equal(all.items.find(item => item.id === 'K-BBBB').link, null)
})

test('answer: success marks the decision for the engine; a stale version comes back as a conflict with the latest decision', async () => {
  const h = harness({ decisions: [raw('K-AAAA')] })
  const stale = await h.core.answer({ id: 'K-AAAA', optionId: 'o1', version: 9, idempotencyKey: 'k-12345678' }, h.effect)
  assert.equal(stale.outcome, 'conflict'); assert.equal(stale.decision.version, 1)
  const ok = await h.core.answer({ id: 'K-AAAA', optionId: 'o1', version: 1, idempotencyKey: 'k-12345678' }, h.effect)
  assert.equal(ok.outcome, 'answered'); assert.equal(ok.decision.status, 'answered')
})

test('refresh: a BellTeam decision becomes one approval-box-lane task (link first), and its answer completes that task', async () => {
  const h = harness({ decisions: [raw('K-AAAA')] })
  const first = await h.core.refresh({ since: 0 }, h.effect)
  assert.equal(first.summary.pending, 1)
  const order = h.calls.filter(([method]) => method.startsWith('lattice.')).map(([method, params]) => params.args ? params.args.slice(0, 2).join(' ') : method)
  assert.deepEqual(order.filter(item => item !== 'lattice.charts' && item !== 'lattice.chart'), ['lattice.link', 'plan create'])
  const created = [...h.writes.values()][0]
  assert.equal(created.input.tasks[0].task_id, 'dec-k-aaaa'); assert.equal(created.input.tasks[0].lane, 'approval-box')
})

test('refresh: an answered decision with a link row starts then finishes its task, once', async () => {
  const answered = raw('K-AAAA', { status: 'answered', version: 2, answer: { option_id: 'o1', answered_at: '2026-11-15T02:00:00Z' } })
  const row = { decisionId: 'K-AAAA', projectId: 'bellteam', plan: 'approval-box', taskId: 'dec-k-aaaa', state: 'linked', attached: false, sessionLabel: 'ブレッディ / billing', handledVersion: 1, updatedAt: '2026-11-15T01:00:00Z' }
  const cards = [{ id: 'approval-box/dec-k-aaaa', plan: 'approval-box', taskId: 'dec-k-aaaa', state: 'ready', lane: 'approval-box', title: 't' }]
  const h = harness({ decisions: [answered], cards, rowsText: JSON.stringify({ version: 1, rows: [row] }) })
  await h.core.refresh({ since: 0 }, h.effect)
  assert.deepEqual([...h.writes.keys()].map(key => key.split(' ').slice(0, 2).join(' ')), ['todo start', 'todo done'])
  assert.match([...h.writes.keys()][1], /同じにする/u)
  const writesBefore = h.writes.size
  await h.core.refresh({ since: 0 }, h.effect)
  assert.equal(h.writes.size, writesBefore) // the row is answered now: a replay does nothing
})

test('refresh: an external decision causes no Lattice write at all', async () => {
  const h = harness({ decisions: [raw('K-BBBB', { source: { client: 'codex', session_label: 'someone else' } })] })
  await h.core.refresh({ since: 0 }, h.effect)
  assert.deepEqual(h.calls.filter(([method]) => method === 'lattice.ownerTask' || method === 'lattice.link'), [])
})

// a490g: what the daemon holds (seats' and the body's decisions), shaped as the parent effect returns it (no context, no history).
const held = (id, extra = {}) => ({ id, title: '請求を同じにするか', status: 'pending', version: 1, urgency: 'normal', sessionLabel: 'ブレッディ / billing', requester: 'ブレッディ', cancelReason: null,
  createdAt: '2026-11-15T01:00:00Z', updatedAt: '2026-11-15T01:00:00Z', options: [{ id: 'o1', label: '同じにする' }, { id: 'o2', label: '別にする' }], answer: null, ...extra })

test('daemon feed: a decision only the daemon holds becomes a task (BellTeam by roster name) and its answer finishes it; the /v1 side stays empty', async () => {
  const daemon = new Map([['K-DDDD', held('K-DDDD')]])
  const h = harness({ decisions: [], daemon })
  await h.core.refresh({ since: 0 }, h.effect)
  assert.equal([...h.writes.values()][0].input.tasks[0].task_id, 'dec-k-dddd') // the first decision task rides in `plan create`
  assert.ok(h.calls.some(([method]) => method === 'lattice.link'))
  assert.ok(!h.box.hits.some(hit => hit.includes('K-DDDD')), 'no /v1 read of a daemon-listed id')
  const cards = [{ id: 'approval-box/dec-k-dddd', plan: 'approval-box', taskId: 'dec-k-dddd', state: 'ready', lane: 'approval-box', title: 't' }]
  const row = { decisionId: 'K-DDDD', projectId: 'bellteam', plan: 'approval-box', taskId: 'dec-k-dddd', state: 'linked', attached: false, sessionLabel: 'ブレッディ / billing', handledVersion: 1, updatedAt: '2026-11-15T01:00:00Z' }
  const answered = new Map([['K-DDDD', held('K-DDDD', { status: 'answered', version: 2, answer: { optionId: 'o1', text: null, answeredAt: '2026-11-15T02:00:00Z' } })]])
  const g = harness({ decisions: [], daemon: answered, cards, rowsText: JSON.stringify({ version: 1, rows: [row] }) })
  await g.core.refresh({ since: 0 }, g.effect)
  assert.deepEqual([...g.writes.keys()].map(key => key.split(' ').slice(0, 2).join(' ')), ['todo start', 'todo done'])
  assert.match([...g.writes.keys()][1], /同じにする/u)
})

test('daemon feed: a linked row whose decision left the daemon list is still read by id; an unreadable daemon never stops the /v1 feed', async () => {
  const answeredOld = held('K-OLDD', { status: 'answered', version: 2, answer: { optionId: 'o2', text: null, answeredAt: '2026-11-14T02:00:00Z' } })
  const records = new Map([['K-OLDD', answeredOld]])
  const cards = [{ id: 'approval-box/dec-k-oldd', plan: 'approval-box', taskId: 'dec-k-oldd', state: 'ready', lane: 'approval-box', title: 't' }]
  const row = { decisionId: 'K-OLDD', projectId: 'bellteam', plan: 'approval-box', taskId: 'dec-k-oldd', state: 'linked', attached: false, sessionLabel: 'x', handledVersion: 1, updatedAt: '2026-11-14T01:00:00Z' }
  const h = harness({ decisions: [], daemon: { keys: () => [], get: id => records.get(id) }, cards, rowsText: JSON.stringify({ version: 1, rows: [row] }) })
  await h.core.refresh({ since: 0 }, h.effect)
  assert.deepEqual([...h.writes.keys()].map(key => key.split(' ').slice(0, 2).join(' ')), ['todo start', 'todo done'])
  const plain = harness({ decisions: [raw('K-AAAA')] }) // no daemon effects at all: the effect throws, the /v1 feed still creates its task
  await plain.core.refresh({ since: 0 }, plain.effect)
  assert.equal([...plain.writes.values()][0].input.tasks[0].task_id, 'dec-k-aaaa')
})

// a490j: BellTeam's own view also shows what the hosted daemon holds (PC_OFFER on: new decisions live there); answering those happens on a device.
test('view from the daemon: list merges both sources in contract order, get falls back, summary counts both, the cursor page adds nothing', async () => {
  const daemon = new Map([['K-DDDD', held('K-DDDD', { urgency: 'high', createdAt: '2026-11-15T02:00:00Z' })], ['K-DONE', held('K-DONE', { status: 'answered', version: 2, answer: { optionId: 'o1', text: null, answeredAt: '2026-11-15T02:30:00Z' } })]])
  const h = harness({ decisions: [raw('K-AAAA')], daemon })
  const page = await h.core.list({ status: ['pending', 'held'] }, h.effect)
  assert.deepEqual(page.items.map(item => item.id), ['K-DDDD', 'K-AAAA'], '急ぎ first, then older first; the answered one is not in the pending list')
  assert.equal(page.items[0].origin.kind, 'bellteam') // roster-name match (no requester_bot_id in the daemon record)
  const answered = await h.core.list({ status: ['answered'] }, h.effect)
  assert.ok(answered.items.some(item => item.id === 'K-DONE'))
  const paged = await h.core.list({ status: ['pending', 'held'], cursor: 'c1' }, h.effect)
  assert.ok(!paged.items.some(item => item.id === 'K-DDDD'))
  assert.equal((await h.core.get({ id: 'K-DDDD' }, h.effect)).id, 'K-DDDD')
  await assert.rejects(() => h.core.get({ id: 'K-NONE' }, h.effect), { code: 'APPROVALS_NOT_FOUND' })
  const summary = await h.core.summary({}, h.effect)
  assert.equal(summary.pending, 2); assert.equal(summary.urgent, 1)
})

test('view from the daemon: answer, hold and unhold of a daemon-only decision answer "on a device", a /v1 decision is unchanged', async () => {
  const h = harness({ decisions: [raw('K-AAAA')], daemon: new Map([['K-DDDD', held('K-DDDD')]]) })
  for (const call of [() => h.core.answer({ id: 'K-DDDD', optionId: 'o1', version: 1, idempotencyKey: 'abcdefgh' }, h.effect), () => h.core.hold({ id: 'K-DDDD' }, h.effect), () => h.core.unhold({ id: 'K-DDDD' }, h.effect)])
    await assert.rejects(call, { code: 'APPROVALS_ANSWER_ON_DEVICE', status: 409 })
  assert.deepEqual(approvalsWireError({ code: 'APPROVALS_ANSWER_ON_DEVICE' }, 'x'), { code: 'APPROVALS_ANSWER_ON_DEVICE', status: 409, outcome: 'x' })
  const done = await h.core.answer({ id: 'K-AAAA', optionId: 'o1', version: 1, idempotencyKey: 'abcdefgh' }, h.effect)
  assert.equal(done.outcome, 'answered')
  await assert.rejects(() => h.core.answer({ id: 'K-NONE', optionId: 'o1', version: 1, idempotencyKey: 'abcdefgh' }, h.effect), { code: 'APPROVALS_NOT_FOUND' })
})

test('byDecision: ids and state of a linked decision, null for none; never calls Approval Box', async () => {
  const row = { decisionId: 'K-AAAA', projectId: 'bellteam', plan: 'approval-box', taskId: 'dec-k-aaaa', state: 'answered', attached: true, sessionLabel: 'x', handledVersion: 1, updatedAt: '2026-11-15T01:00:00Z' }
  const h = harness({ decisions: [], rowsText: JSON.stringify({ version: 1, rows: [row] }) })
  assert.deepEqual(await h.core.byDecision({ id: 'K-AAAA' }, h.effect), { project: 'bellteam', plan: 'approval-box', task: 'dec-k-aaaa', state: 'answered', attached: true })
  assert.equal(await h.core.byDecision({ id: 'K-ZZZZ' }, h.effect), null)
  assert.ok(h.box.hits.every(hit => hit === 'GET /v1/me'), 'only the entitlement read (/v1/me stays)')
  validateApprovalsResult('byDecision', await h.core.byDecision({ id: 'K-AAAA' }, h.effect))
  validateApprovalsResult('byDecision', null)
  validateApprovalsRequest('byDecision', { id: 'K-AAAA' }, { generation: 'g1' })
  assert.throws(() => validateApprovalsRequest('byDecision', { id: 'nope' }, { generation: 'g1' }), { code: 'APPROVALS_INVALID' })
  validateApprovalsEffect('daemon.decisions.list', {}); validateApprovalsEffect('daemon.decisions.read', { id: 'K-AAAA' })
  assert.throws(() => validateApprovalsEffect('daemon.decisions.read', { id: 'x' }))
  validateApprovalsEffectResult('daemon.decisions.list', [{ id: 'K-AAAA' }])
  validateApprovalsEffectResult('daemon.decisions.read', held('K-AAAA')); validateApprovalsEffectResult('daemon.decisions.read', null)
  assert.throws(() => validateApprovalsEffectResult('daemon.decisions.read', { ...held('K-AAAA'), context: 'leaks' }), { code: 'APPROVALS_IPC_INVALID' })
})

test('connect: the request code opens the hosted page, the poll hands over the session once, the child stores it with session.put', async () => {
  const h = harness({ session: null, decisions: [], pairing: { status: 'claimed', session: 'kss_new', expires_at: '2099-02-01T00:00:00Z' } })
  const started = await h.core.connect({}, h.effect)
  assert.match(started.authorizationUrl, /^https:\/\/approval-box\.kitepon\.dev\/pair\?c=/u)
  await new Promise(resolve => setTimeout(resolve, 20))
  const value = await h.core.connection({}, h.effect)
  assert.equal(value.state, 'connected'); assert.match(h.stored(), /kss_new/u)
  await h.core.disconnect({}, h.effect)
  assert.equal(h.stored(), null)
})

test('connect: a refused session.put keeps the session in memory and saves it again on a later root (a198)', async () => {
  const h = harness({ session: null, decisions: [], pairing: { status: 'claimed', session: 'kss_new', expires_at: '2099-02-01T00:00:00Z' } })
  let refuse = true
  const effect = (method, params) => method === 'session.put' && refuse ? Promise.reject(new Error('unavailable')) : h.effect(method, params)
  await h.core.connect({}, effect)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal((await h.core.connection({}, effect)).state, 'connected'); assert.equal(h.stored(), null) // works in memory, nothing stored yet
  refuse = false
  assert.equal((await h.core.connection({}, effect)).state, 'connected'); assert.match(h.stored(), /kss_new/u) // the next root saves it
})

test('byTask: a linked task answers its decision; anything else (or any failure) answers null', async () => {
  const h = harness({ decisions: [raw('K-AAAA')] })
  assert.equal(await h.core.byTask({ project: 'bellteam', plan: 'approval-box', task: 'dec-k-aaaa' }, h.effect), null)
})

test('protocol: requests and effects are validated; a bad answer (both option and text) is refused', () => {
  const ctx = { generation: 'g1' }
  validateApprovalsRequest('answer', { id: 'K-AAAA', optionId: 'o1', version: 1, idempotencyKey: 'abcdefgh' }, ctx)
  assert.throws(() => validateApprovalsRequest('answer', { id: 'K-AAAA', optionId: 'o1', text: 'x', version: 1, idempotencyKey: 'abcdefgh' }, ctx), { code: 'APPROVALS_INVALID' })
  assert.throws(() => validateApprovalsRequest('list', { status: ['bogus'] }, ctx))
  validateApprovalsEffect('lattice.ownerTask', { projectId: 'bellteam', args: ['todo', 'note'], input: null })
  assert.throws(() => validateApprovalsEffect('lattice.ownerTask', { projectId: 'bellteam', args: ['todo'], input: null, from: 'owner' }))
  assert.throws(() => validateApprovalsEffect('secrets.get', {}), { code: 'APPROVALS_INVALID' })
  validateApprovalsEffectResult('session.get', null)
  validateApprovalsResult('connection', { state: 'not_connected', entitled: false, entitlement: { state: 'none' } })
  assert.equal(approvalsWireError({ code: 'APPROVALS_NOT_ENTITLED' }, 'unknown').status, 403)
})

test('dispatcher: a root is served only after resume and within its generation', async () => {
  const dispatcher = createApprovalsDispatcher({ core: { connection: async () => ({ state: 'not_connected', entitled: false, entitlement: { state: 'none' } }) } })
  await dispatcher.control('initialize', { generation: 'g1', mode: 'bootstrap' })
  assert.throws(() => dispatcher.validateRequest('connection', {}, { generation: 'g1' }), { code: 'APPROVALS_NOT_ACCEPTED' })
  await dispatcher.control('resume', {})
  dispatcher.validateRequest('connection', {}, { generation: 'g1' })
  assert.equal((await dispatcher.dispatch('connection', {}, { generation: 'g1' }, async () => null)).state, 'not_connected')
})

test('link-plan: free text that starts with dashes never reaches the owner-task allowlist as a flag', () => {
  const d = { id: 'K-9', title: '--evil title', status: 'pending', version: 1, origin: { kind: 'bellteam', sessionLabel: '' }, requester: null, amended: { is: false, fields: [] }, options: [] }
  const add = planLink({ d, row: null, chart: { projectId: 'bellteam', cards: [], edges: [] } }).actions.find(a => a.args?.[1] === 'add').args
  assert.ok(!add[add.indexOf('--title') + 1].startsWith('--'))
})

// ---- http handler with a fake facade and a fake response
function reply() {
  const out = { status: null, headers: {}, body: '' }
  const response = { writeHead(status, headers = {}) { out.status = status; Object.assign(out.headers, headers) }, write(chunk) { out.body += chunk }, end(chunk = '') { out.body += chunk }, setHeader(name, value) { out.headers[name] = value } }
  return { out, response }
}
const call = async (api, method, path, { headers = {}, body } = {}) => {
  const { out, response } = reply()
  const request = Object.assign((async function* () { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) })(), { method, headers, on() {} })
  const result = await api(request, response, new URL(`http://x${path}`))
  return { handled: result !== false, status: out.status, body: out.body ? JSON.parse(out.body) : null, headers: out.headers }
}
test('http: owner only, JSON and Idempotency-Key required for answers, errors become the contract bodies', async () => {
  const facade = {
    connection: async () => ({ state: 'connected', entitled: false, entitlement: { state: 'none' } }),
    list: async () => { throw Object.assign(new Error('x'), { code: 'APPROVALS_NOT_ENTITLED' }) },
    answer: async () => ({ outcome: 'conflict', decision: { id: 'K-AAAA' } }),
    subscribe: () => () => {},
  }
  const api = createApprovalsApi({ facade, internal: false })
  const internal = createApprovalsApi({ facade, internal: true })
  assert.equal((await call(internal, 'GET', '/api/approvals/summary')).status, 403)
  assert.equal((await call(api, 'GET', '/api/other')).handled, false)
  const denied = await call(api, 'GET', '/api/approvals')
  assert.deepEqual([denied.status, denied.body.error.code, denied.body.error.state], [403, 'not_entitled', 'none'])
  const json = { 'content-type': 'application/json' }
  assert.equal((await call(api, 'POST', '/api/approvals/K-AAAA/answer', { headers: json, body: { optionId: 'o1', version: 1 } })).status, 400)
  const conflict = await call(api, 'POST', '/api/approvals/K-AAAA/answer', { headers: { ...json, 'idempotency-key': 'abcdefgh-1' }, body: { optionId: 'o1', version: 1 } })
  assert.deepEqual([conflict.status, conflict.body.error.code, conflict.body.error.decision.id], [409, 'conflict', 'K-AAAA'])
  assert.equal((await call(api, 'POST', '/api/approvals/K-AAAA/answer', { headers: { 'idempotency-key': 'abcdefgh-1' }, body: {} })).status, 415)
})

test('http: an attachment is sandboxed and only images are inline (the sender may not be ours)', async () => {
  const serve = async contentType => {
    const { out, response } = reply()
    const api = createApprovalsApi({ facade: { attachment: async () => ({ contentType, size: 1, data: 'AA==' }) }, internal: false })
    await api({ method: 'GET', headers: {}, on() {} }, response, new URL('http://x/api/approvals/K-AAAA/attachments/a1'))
    return out.headers
  }
  const svg = await serve('image/svg+xml'), png = await serve('image/png')
  assert.match(svg['content-security-policy'], /^sandbox;/u)
  assert.deepEqual([svg['content-disposition'], png['content-disposition'], png['content-security-policy'] === svg['content-security-policy']], ['attachment', 'inline', true])
})
test('module.json source lists every file of src/approval-box-extension* (the packager test pattern)', () => {
  const listed = JSON.parse(readFileSync(new URL('../docs/architecture/modules/approval-box-extension/module.json', import.meta.url), 'utf8')).source
  const files = [...readdirSync(new URL('../src/approval-box-extension', import.meta.url)).map(name => `src/approval-box-extension/${name}`),
    ...readdirSync(new URL('../src', import.meta.url)).filter(name => name.startsWith('approval-box-extension-')).map(name => `src/${name}`)]
  assert.deepEqual([...listed].sort(), files.sort())
})
