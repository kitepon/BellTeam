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
function harness({ decisions = [], session = { token: 'kss_x', expiresAt: null }, cards = [], me = ME, pairing = null, rowsText = null, bookText = null, seatMessage = null, p1 = null, now = () => Date.parse('2026-11-15T03:00:00Z') } = {}) {
  const calls = [], writes = new Map(), files = new Map(), box = { decisions: new Map(decisions.map(d => [d.id, d])), me, hits: [] }
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
    if (method === 'seat.message') { if (!seatMessage) throw new Error('unexpected effect'); return seatMessage(params) }
    if (method.startsWith('decisions.')) { if (!p1) throw new Error('unexpected effect'); return p1[method.slice('decisions.'.length)](params) }
    if (method === 'members.list') return [{ id: 'bot-823b56e9', name: 'ブレッディ' }, { id: 'bot-7b140b27', name: 'トロニー' }]
    if (method === 'lattice.charts') return [{ projectId: 'bellteam', name: 'BellTeam開発', createdBy: 'bot-7b140b27', coordinator: true }]
    if (method === 'lattice.chart') return { cards: chartCards, edges: [] }
    if (method === 'lattice.link') return { schema: 'bellteam.lattice-link.v1', ...params, linked: true }
    if (method === 'lattice.ownerTask') { writes.set(params.args.join(' '), params); return { exitCode: 0, result: {}, stdout: null, stderr: '' } }
    throw new Error(`unexpected effect ${method}`)
  }
  const core = createApprovalBoxExtensionCore({ client, now, files: { read: async path => (path.endsWith('answers.json') ? bookText : rowsText), write: async (path, text) => { files.set(path.split('/').pop(), text) } }, streamBackoffMs: 5 })
  return { core, effect, calls, writes, box, files, stored: () => stored }
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
// ---- F8 answer relay (README section 13)
const answeredRaw = (id, extra = {}) => raw(id, { status: 'answered', version: 2, answer: { option_id: 'o1', text: '本番は金曜に', answered_at: '2026-11-15T02:00:00Z' }, ...extra })
const BOOK = JSON.stringify({ version: 2, since: '2026-11-15T01:30:00Z', rows: [] })
const sent = () => { const log = []; return { log, fn: async params => { log.push(params); return { delivery: 'steered', deliveryId: 'd-1' } } } }

test('A1/A3/A4/A6: an answer made after the ledger began is sent once to the asking seat, then the view says delivered', async () => {
  const seat = sent()
  const h = harness({ decisions: [answeredRaw('K-AAAA', { delivery: 'unknown' })], bookText: BOOK, seatMessage: seat.fn })
  await h.core.refresh({ since: 0 }, h.effect)
  assert.equal(seat.log.length, 1)
  assert.equal(seat.log[0].target, 'bot-823b56e9')
  assert.match(seat.log[0].message, /K-AAAA/u); assert.match(seat.log[0].message, /同じにする/u); assert.match(seat.log[0].message, /本番は金曜に/u)
  assert.deepEqual(JSON.parse(h.files.get('answers.json')).rows.map(row => [row.decisionId, row.delivery]), [['K-AAAA', 'steered']])
  assert.doesNotMatch(h.files.get('answers.json'), /本番は金曜に/u) // ids and delivery words only (A5)
  await h.core.refresh({ since: 0 }, h.effect)
  assert.equal(seat.log.length, 1) // a replay sends nothing
  assert.equal((await h.core.get({ id: 'K-AAAA' }, h.effect)).delivery, 'delivered')
})

test('A2: an answer from before the ledger began, a stale one, an external one and a pending one are never sent', async () => {
  const seat = sent()
  const before = answeredRaw('K-BEF1', { answer: { option_id: 'o1', answered_at: '2026-11-15T01:00:00Z' } })
  const outside = answeredRaw('K-EXT1', { source: { client: 'cursor', session_label: 'Mac / receipts' } })
  const h = harness({ decisions: [before, outside, raw('K-PEND')], bookText: BOOK, seatMessage: seat.fn })
  await h.core.refresh({ since: 0 }, h.effect)
  assert.equal(seat.log.length, 0)
  const late = harness({ decisions: [answeredRaw('K-OLD1')], bookText: BOOK, seatMessage: seat.fn, now: () => Date.parse('2026-11-17T03:00:00Z') })
  await late.core.refresh({ since: 0 }, late.effect)
  assert.equal(seat.log.length, 0)
  const first = harness({ decisions: [answeredRaw('K-FRST')], seatMessage: seat.fn }) // no ledger yet: since = now, so the old answer is not replayed
  await first.core.refresh({ since: 0 }, first.effect)
  assert.equal(seat.log.length, 0); assert.ok(first.files.get('answers.json'))
})

test('A4: a failed send keeps the id for the next tick; a permanent refusal is recorded and never retried', async () => {
  let fail = true
  const h = harness({ decisions: [answeredRaw('K-AAAA')], bookText: BOOK, seatMessage: async () => { if (fail) throw new Error('down'); return { delivery: 'queued', deliveryId: 'd-2' } } })
  await h.core.refresh({ since: 0 }, h.effect)
  assert.equal(h.files.get('answers.json'), undefined)
  fail = false
  await h.core.refresh({ since: 0 }, h.effect)
  assert.equal(JSON.parse(h.files.get('answers.json')).rows[0].delivery, 'queued')
  const gone = harness({ decisions: [answeredRaw('K-AAAA', { delivery: 'unknown' })], bookText: BOOK, seatMessage: async () => ({ delivery: 'refused', deliveryId: null, code: 'BOT_NOT_FOUND' }) })
  await gone.core.refresh({ since: 0 }, gone.effect)
  assert.equal(JSON.parse(gone.files.get('answers.json')).rows[0].delivery, 'refused')
  assert.equal((await gone.core.get({ id: 'K-AAAA' }, gone.effect)).delivery, 'unknown') // a refusal never turns into delivered
})

test('A1: the catch-up finds an answer whose event was missed (answered list)', async () => {
  const seat = sent()
  const h = harness({ decisions: [answeredRaw('K-AAAA')], bookText: BOOK, seatMessage: seat.fn })
  await h.core.refresh({ since: 0 }, h.effect)
  assert.deepEqual(seat.log.map(item => /K-[A-Z]{4}/u.exec(item.message)[0]).sort(), ['K-AAAA'])
})

test('seat.message: the protocol takes {target, message} and answers {delivery, deliveryId, code?}', () => {
  assert.doesNotThrow(() => validateApprovalsEffect('seat.message', { target: 'bot-823b56e9', message: 'x' }))
  assert.throws(() => validateApprovalsEffect('seat.message', { target: 'bot-823b56e9', message: '' }))
  assert.throws(() => validateApprovalsEffect('seat.message', { target: 'bot-823b56e9', message: 'x', from: 'user' }))
  assert.doesNotThrow(() => validateApprovalsEffectResult('seat.message', { delivery: 'steered', deliveryId: null }))
  assert.doesNotThrow(() => validateApprovalsEffectResult('seat.message', { delivery: 'refused', deliveryId: null, code: 'BOT_NOT_FOUND' }))
  assert.throws(() => validateApprovalsEffectResult('seat.message', { delivery: 3, deliveryId: null }))
})

test('F8 fails closed on entitlement: an expired Approval Box account (the Owner body 11/27: state expired) sends nothing; trial and active send', async () => {
  const seat = sent()
  const expired = harness({ decisions: [answeredRaw('K-AAAA')], bookText: BOOK, seatMessage: seat.fn, me: { plan: 'expired' } })
  await expired.core.refresh({ since: 0 }, expired.effect)
  assert.equal(seat.log.length, 0)
  for (const me of [{ plan: 'trial', billing: 'store' }, { plan: 'active' }]) {
    const ok = harness({ decisions: [answeredRaw('K-AAAA')], bookText: BOOK, seatMessage: seat.fn, me })
    await ok.core.refresh({ since: 0 }, ok.effect)
  }
  assert.equal(seat.log.length, 2)
})

test('F8: a Lattice step that fails every tick never keeps the answer from the seat; the id stays for the next tick', async () => {
  const seat = sent()
  const answered = answeredRaw('K-AAAA')
  const row = { decisionId: 'K-AAAA', projectId: 'bellteam', plan: 'approval-box', taskId: 'dec-k-aaaa', state: 'linked', attached: false, sessionLabel: 'ブレッディ / billing', handledVersion: 1, updatedAt: '2026-11-15T01:00:00Z' }
  const cards = [{ id: 'approval-box/dec-k-aaaa', plan: 'approval-box', taskId: 'dec-k-aaaa', state: 'ready', lane: 'approval-box', title: 't' }]
  const h = harness({ decisions: [answered], cards, rowsText: JSON.stringify({ version: 1, rows: [row] }), bookText: BOOK, seatMessage: seat.fn })
  const original = h.effect
  const broken = async (method, params) => { if (method === 'lattice.ownerTask') throw new Error('lattice down'); return original(method, params) }
  await h.core.refresh({ since: 0 }, broken)
  assert.equal(seat.log.length, 1)
})

test('A2: the ledger starts at the first tick after install even while the gate is closed; a version 1 ledger (made late, on the first entitled tick) moves back to the release date', async () => {
  const seat = sent()
  const closed = harness({ decisions: [], seatMessage: seat.fn, me: { plan: 'expired' } })
  await closed.core.refresh({ since: 0 }, closed.effect)
  assert.deepEqual(JSON.parse(closed.files.get('answers.json')), { version: 2, since: '2026-11-15T03:00:00.000Z', rows: [] })
  // K-9DBLUD 2026-11-27: answered 12:35Z, ledger made at 12:44Z by the old child
  const late = JSON.stringify({ version: 1, since: '2026-11-27T12:44:10.000Z', rows: [] })
  const answered = answeredRaw('K-9DBL', { answer: { option_id: 'o1', answered_at: '2026-11-27T12:35:00Z' } })
  const h = harness({ decisions: [answered], bookText: late, seatMessage: seat.fn, now: () => Date.parse('2026-11-27T12:50:00Z') })
  await h.core.refresh({ since: 0 }, h.effect)
  assert.equal(seat.log.length, 1); assert.match(seat.log[0].message, /21:35 JST/u)
  assert.equal(JSON.parse(h.files.get('answers.json')).version, 2)
  const again = harness({ decisions: [answeredRaw('K-OLDR', { answer: { option_id: 'o1', answered_at: '2026-11-27T10:00:00Z' } })], bookText: late, seatMessage: seat.fn, now: () => Date.parse('2026-11-27T12:50:00Z') })
  await again.core.refresh({ since: 0 }, again.effect)
  assert.equal(seat.log.length, 1) // answered before the release: never sent
})

test('module.json source lists every file of src/approval-box-extension* (the packager test pattern)', () => {
  const listed = JSON.parse(readFileSync(new URL('../docs/architecture/modules/approval-box-extension/module.json', import.meta.url), 'utf8')).source
  const files = [...readdirSync(new URL('../src/approval-box-extension', import.meta.url)).map(name => `src/approval-box-extension/${name}`),
    ...readdirSync(new URL('../src', import.meta.url)).filter(name => name.startsWith('approval-box-extension-')).map(name => `src/${name}`)]
  assert.deepEqual([...listed].sort(), files.sort())
})

// F9 withdrawal (README section 5b): rows the module filed earlier (machine-written text) are cancelled and dropped; nothing is ever filed.
const clock = start => { let t = Date.parse(start); return { now: () => t, advance: ms => { t += ms } } }
const rowsOf = h => JSON.parse(h.files.get('links.json')).rows
const filedRow = (id, taskId) => ({ decisionId: id, projectId: 'bellteam', plan: 'p1', taskId, state: 'linked', attached: true, filed: true, sessionLabel: `Lattice bellteam p1/${taskId}`, handledVersion: 1, updatedAt: '2026-11-28T01:59:00Z' })
const ownedRow = { decisionId: 'K-AAAA', projectId: 'bellteam', plan: 'p1', taskId: 't9', state: 'linked', attached: true, sessionLabel: 'Lattice bellteam p1/t9', handledVersion: 1, updatedAt: '2026-11-28T01:59:00Z' }

test('F9 withdrawal: a filed row is cancelled with 作り直します and dropped; an AI-filed row stays; nothing is filed for an open Owner card', async () => {
  const cancelled = [], p1 = { cancel: async params => (cancelled.push(params), { status: 'cancelled' }), file: async () => { throw new Error('the module never files') } }
  const c = clock('2026-11-28T02:00:00Z')
  const h = harness({ decisions: [raw('K-AAAA')], p1, seatMessage: async () => ({ delivery: 'delivered', deliveryId: 'd' }), now: c.now, cards: [{ id: 'p1/t1', plan: 'p1', taskId: 't1', state: 'ready', lane: 'approval-box', title: 'x' }],
    rowsText: JSON.stringify({ version: 1, rows: [filedRow('K-OWN1', 't1'), filedRow('K-OWN2', 't2'), ownedRow] }) })
  await h.core.refresh({ since: 0 }, h.effect)
  assert.deepEqual(cancelled.map(item => [item.decisionId, item.reason]).sort(), [['K-OWN1', '作り直します'], ['K-OWN2', '作り直します']])
  assert.deepEqual(rowsOf(h).map(row => row.decisionId), ['K-AAAA'])
  assert.ok(!h.calls.some(([method]) => method.startsWith('decisions.') && method !== 'decisions.cancel'), 'the module never files')
})

test('F9 withdrawal: P1 unavailable keeps the row for the next scan; a refusal (already answered) drops it', async () => {
  let mode = 'down'
  const p1 = { cancel: async () => { if (mode === 'down') throw Object.assign(new Error('x'), { code: 'APPROVAL_BOX_EXTENSION_DECISIONS_UNAVAILABLE' }); throw Object.assign(new Error('r'), { code: 'APPROVALS_EFFECT_REFUSED' }) } }
  const c = clock('2026-11-28T02:00:00Z')
  const h = harness({ decisions: [], p1, now: c.now, rowsText: JSON.stringify({ version: 1, rows: [filedRow('K-OWN1', 't1')] }) })
  await h.core.refresh({ since: 0 }, h.effect)
  assert.ok(!h.files.has('links.json'), 'unavailable: nothing written, the row waits')
  mode = 'refused'; c.advance(61_000)
  await h.core.refresh({ since: 0 }, h.effect)
  assert.deepEqual(rowsOf(h), [])
})

const oc = (taskId, extra = {}) => ({ id: `p1/${taskId}`, plan: 'p1', taskId, state: 'ready', lane: 'approval-box', title: 'App Storeのプライバシーを直す', addedBy: 'bot-823b56e9', ...extra })
const sentLog = () => { const log = []; return { log, fn: async params => (log.push(params), { delivery: 'delivered', deliveryId: 'd' + log.length }) } }

test('F9 O1: the Bot that added a startable Owner-lane task is told once, the card is linked, nothing is filed; unstartable, other-lane and ended cards are not told', async () => {
  const seat = sentLog(), c = clock('2026-11-28T03:00:00Z')
  const h = harness({ decisions: [], seatMessage: seat.fn, now: c.now, cards: [oc('t1'), oc('t2', { lane: '決裁箱', addedBy: null }), oc('t3', { state: 'pending' }), oc('t4', { lane: 'bot-823b56e9' }), oc('t5', { state: 'done' }), oc('t6', { lane: 'Approval-Box', state: 'in-progress' })] })
  await h.core.refresh({ since: 0 }, h.effect)
  assert.deepEqual(seat.log.map(item => item.target), ['bot-823b56e9', 'bot-7b140b27', 'bot-823b56e9']) // t2 has no addedBy: the chart creator (bot-7b140b27) is told
  assert.match(seat.log[0].message, /Lattice bellteam p1\/t1/u)
  assert.match(seat.log[0].message, /language the user rules give/u)
  assert.deepEqual(h.calls.filter(([m]) => m === 'lattice.link').map(([, p]) => p.taskId), ['t1', 't2', 't6'])
  assert.ok(!h.calls.some(([m]) => m.startsWith('decisions.')), 'the module files nothing')
  const record = JSON.parse(h.files.get('owner-told.json')).items
  assert.deepEqual(Object.keys(record).sort(), ['bellteam/p1/t1', 'bellteam/p1/t2', 'bellteam/p1/t6'])
})

test('F9 O1: told again only after 60 min; the first telling links, a reminder does not link again', async () => {
  const seat = sentLog(), c = clock('2026-11-28T03:00:00Z')
  const h = harness({ decisions: [], seatMessage: seat.fn, now: c.now, cards: [oc('t1')] })
  await h.core.refresh({ since: 0 }, h.effect)
  c.advance(61_000); await h.core.refresh({ since: 0 }, h.effect)
  assert.equal(seat.log.length, 1, 'not within 60 min')
  c.advance(60 * 60_000); await h.core.refresh({ since: 0 }, h.effect)
  assert.equal(seat.log.length, 2)
  assert.match(seat.log[1].message, /reminder 2/u)
  assert.equal(h.calls.filter(([m]) => m === 'lattice.link').length, 1)
})

test('F9 O2/O3: a card with a link row is not told; a told record is dropped when its card can no longer start', async () => {
  const seat = sentLog(), c = clock('2026-11-28T03:00:00Z'), cards = [oc('t1'), oc('t2')]
  const row = { decisionId: 'K-AAAA', projectId: 'bellteam', plan: 'p1', taskId: 't1', state: 'linked', attached: true, sessionLabel: 'Lattice bellteam p1/t1', handledVersion: 1, updatedAt: '2026-11-28T03:00:00Z' }
  const h = harness({ decisions: [raw('K-AAAA')], seatMessage: seat.fn, now: c.now, cards, rowsText: JSON.stringify({ version: 1, rows: [row] }) })
  await h.core.refresh({ since: 0 }, h.effect)
  assert.deepEqual(seat.log.map(item => /p1\/(t\d)/u.exec(item.message)[1]), ['t2'], 'the card with a request is not told')
  assert.deepEqual(Object.keys(JSON.parse(h.files.get('owner-told.json')).items), ['bellteam/p1/t2'])
  cards[1].state = 'pending'; c.advance(61_000)
  await h.core.refresh({ since: 0 }, h.effect)
  assert.deepEqual(JSON.parse(h.files.get('owner-told.json')).items, {}, 'the record is dropped')
})

test('F9 O5: a Bot that is gone and a chart without a creator are skipped; an unaccepted send is tried again next scan', async () => {
  let accept = false
  const seat = { log: [], fn: async params => { seat.log.push(params); return accept ? { delivery: 'delivered', deliveryId: 'd' } : { delivery: 'failed', deliveryId: null } } }
  const c = clock('2026-11-28T03:00:00Z')
  const h = harness({ decisions: [], seatMessage: seat.fn, now: c.now, cards: [oc('t1', { addedBy: 'bot-gone' })] })
  await h.core.refresh({ since: 0 }, h.effect)
  assert.equal(seat.log[0].target, 'bot-7b140b27', 'the creator is told when the adder left the roster')
  assert.ok(!h.files.has('owner-told.json'), 'not accepted: nothing recorded')
  accept = true; c.advance(61_000)
  await h.core.refresh({ since: 0 }, h.effect)
  assert.equal(JSON.parse(h.files.get('owner-told.json')).items['bellteam/p1/t1'].count, 1)
})

test('F9 O6: an attached request whose Owner-lane task stops being startable is withdrawn by its filer (told hourly); the module cancels nothing itself; a cancel closes the row without retiring the task', async () => {
  const seat = sentLog(), c = clock('2026-11-28T03:00:00Z'), cards = [oc('t1', { state: 'pending' })]
  const row = { decisionId: 'K-AAAA', projectId: 'bellteam', plan: 'p1', taskId: 't1', state: 'linked', attached: true, sessionLabel: 'Lattice bellteam p1/t1', handledVersion: 1, updatedAt: '2026-11-28T03:00:00Z' }
  const h = harness({ decisions: [raw('K-AAAA')], seatMessage: seat.fn, now: c.now, cards, rowsText: JSON.stringify({ version: 1, rows: [row] }) })
  await h.core.refresh({ since: 0 }, h.effect)
  assert.equal(seat.log.length, 1)
  assert.match(seat.log[0].message, /cancel_decision K-AAAA/u)
  assert.equal(seat.log[0].target, 'bot-823b56e9')
  assert.ok(!h.calls.some(([method]) => method.startsWith('decisions.')), 'the module never cancels an AI request')
  c.advance(61_000); await h.core.refresh({ since: 0 }, h.effect)
  assert.equal(seat.log.length, 1, 'not within 60 min')
  cards[0].state = 'ready'; c.advance(61_000); await h.core.refresh({ since: 0 }, h.effect)
  assert.deepEqual(JSON.parse(h.files.get('owner-told.json')).items, {}, 'startable again: the withdraw record is dropped, and the linked card is not told')
  // the filer cancels the request: the row closes, the task is not retired
  h.box.decisions.set('K-AAAA', { ...raw('K-AAAA'), status: 'cancelled', version: 2, cancel_reason: '着手できないため' })
  h.calls.length = 0; h.writes.clear(); await h.core.refresh({ since: 0 }, h.effect)
  assert.ok(![...h.writes.keys()].some(verb => verb.startsWith('todo retire')), 'an attached task is not retired by a cancel')
})

test('F9: one failing card or a failing withdrawal never stops the telling of the others', async () => {
  const seat = sentLog(), c = clock('2026-11-28T03:00:00Z')
  const failing = harness({ decisions: [], p1: { cancel: async () => { throw Object.assign(new Error('x'), { code: 'APPROVAL_BOX_EXTENSION_DECISIONS_UNAVAILABLE' }) } }, seatMessage: async params => { if (/p1\/t1/u.test(params.message)) throw new Error('send failed'); return seat.fn(params) }, now: c.now,
    cards: [oc('t1'), oc('t2')], rowsText: JSON.stringify({ version: 1, rows: [{ decisionId: 'K-OWN1', projectId: 'bellteam', plan: 'p1', taskId: 't9', state: 'linked', attached: true, filed: true, sessionLabel: 'Lattice bellteam p1/t9', handledVersion: 1, updatedAt: '2026-11-28T01:59:00Z' }] }) })
  await failing.core.refresh({ since: 0 }, failing.effect)
  assert.deepEqual(seat.log.map(item => /p1\/(t\d)/u.exec(item.message)[1]), ['t2'], 't1 failed, t2 was still told, the failing withdrawal did not stop it')
  assert.ok(!failing.files.has('links.json'), 'the filed row waits for the next scan')
})

test('O6 only for an open request: an answered request of an unstartable task is never withdrawn, and L2 notes the answer instead of failing to start', async () => {
  const seat = sentLog(), c = clock('2026-11-28T03:00:00Z')
  const row = { decisionId: 'K-AAAA', projectId: 'bellteam', plan: 'p1', taskId: 't1', state: 'linked', attached: true, sessionLabel: 'Lattice bellteam p1/t1', handledVersion: 1, updatedAt: '2026-11-28T03:00:00Z' }
  const answered = raw('K-AAAA', { status: 'answered', version: 2, answer: { option_id: 'o1', answered_at: '2026-11-28T02:00:00Z' } })
  const h = harness({ decisions: [answered], seatMessage: seat.fn, now: c.now, cards: [oc('t1', { state: 'pending' })], rowsText: JSON.stringify({ version: 1, rows: [row] }) })
  await h.core.refresh({ since: 0 }, h.effect)
  assert.equal(seat.log.length, 0, 'no withdraw message for an answered request')
  const verbs = [...h.writes.keys()]
  assert.ok(verbs.some(verb => verb.startsWith('todo note --plan p1 --task t1 --message 指揮官の答え：同じにする') && /着手できる前/u.test(verb)))
  assert.ok(!verbs.some(verb => verb.startsWith('todo start') || verb.startsWith('todo done')), 'start is not attempted on a task that cannot start')
  assert.equal(rowsOf(h)[0].state, 'answered')
})

test('F9 protocol: only the withdrawal effect exists', () => {
  validateApprovalsEffect('decisions.cancel', { decisionId: 'K-AAAA', reason: '作り直します' })
  assert.throws(() => validateApprovalsEffect('decisions.file', { title: 't' }))
  assert.throws(() => validateApprovalsEffect('decisions.read', { decisionId: 'K-AAAA' }))
  validateApprovalsEffectResult('decisions.cancel', { status: 'cancelled' }); validateApprovalsEffectResult('decisions.cancel', { status: 'gone' })
})
