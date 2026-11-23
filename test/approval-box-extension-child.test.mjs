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
  assert.equal(await none.core.byDecision({ id: 'K-AAAA' }, none.effect), null) // the lookups draw nothing when not connected
  assert.equal((await none.core.connection({}, none.effect)).state, 'not_connected')
  assert.deepEqual(await none.core.refresh({ since: 0 }, none.effect), { seq: 0, events: [], summary: null })
  const planless = harness({ me: {}, daemon: new Map([['K-DDDD', held('K-DDDD')]]) })
  await planless.core.refresh({ since: 0 }, planless.effect)
  assert.equal(planless.writes.size, 0, 'a plan-less account links nothing')
  const trial = harness({ me: { plan: 'trial', billing: 'store' }, daemon: new Map([['K-DDDD', held('K-DDDD')]]) })
  await trial.core.refresh({ since: 0 }, trial.effect)
  assert.equal([...trial.writes.values()][0].input.tasks[0].task_id, 'dec-k-dddd')
})

test('connection never calls the network (the exchange probe)', async () => {
  const h = harness({ decisions: [] })
  const value = await h.core.connection({}, h.effect)
  assert.equal(value.state, 'connected'); assert.deepEqual(h.box.hits, [])
})

// a490g: what the daemon holds (seats' and the body's decisions), shaped as the parent effect returns it (no context, no history).
const held = (id, extra = {}) => ({ id, title: '請求を同じにするか', status: 'pending', version: 1, urgency: 'normal', sessionLabel: 'ブレッディ / billing', requester: 'ブレッディ', cancelReason: null,
  createdAt: '2026-11-15T01:00:00Z', updatedAt: '2026-11-15T01:00:00Z', options: [{ id: 'o1', label: '同じにする' }, { id: 'o2', label: '別にする' }], answer: null, ...extra })

test('daemon feed: a decision only the daemon holds becomes one approval-box-lane task (link first, BellTeam by roster name) and its answer finishes it, once', async () => {
  const daemon = new Map([['K-DDDD', held('K-DDDD')]])
  const h = harness({ decisions: [], daemon })
  await h.core.refresh({ since: 0 }, h.effect)
  const order = h.calls.filter(([method]) => method.startsWith('lattice.')).map(([method, params]) => params.args ? params.args.slice(0, 2).join(' ') : method)
  assert.deepEqual(order.filter(item => item !== 'lattice.charts' && item !== 'lattice.chart'), ['lattice.link', 'plan create'])
  const created = [...h.writes.values()][0]
  assert.equal(created.input.tasks[0].task_id, 'dec-k-dddd'); assert.equal(created.input.tasks[0].lane, 'approval-box')
  assert.deepEqual(h.box.hits.filter(hit => !hit.endsWith('/v1/me')), [], 'no /v1 decision read at all')
  const cards = [{ id: 'approval-box/dec-k-dddd', plan: 'approval-box', taskId: 'dec-k-dddd', state: 'ready', lane: 'approval-box', title: 't' }]
  const row = { decisionId: 'K-DDDD', projectId: 'bellteam', plan: 'approval-box', taskId: 'dec-k-dddd', state: 'linked', attached: false, sessionLabel: 'ブレッディ / billing', handledVersion: 1, updatedAt: '2026-11-15T01:00:00Z' }
  const answered = new Map([['K-DDDD', held('K-DDDD', { status: 'answered', version: 2, answer: { optionId: 'o1', text: null, answeredAt: '2026-11-15T02:00:00Z' } })]])
  const g = harness({ decisions: [], daemon: answered, cards, rowsText: JSON.stringify({ version: 1, rows: [row] }) })
  await g.core.refresh({ since: 0 }, g.effect)
  assert.deepEqual([...g.writes.keys()].map(key => key.split(' ').slice(0, 2).join(' ')), ['todo start', 'todo done'])
  assert.match([...g.writes.keys()][1], /同じにする/u)
  const writesBefore = g.writes.size
  await g.core.refresh({ since: 0 }, g.effect)
  assert.equal(g.writes.size, writesBefore) // the row is answered now: a replay does nothing
})

test('daemon feed: an external decision causes no Lattice write at all', async () => {
  const h = harness({ decisions: [], daemon: new Map([['K-EEEE', held('K-EEEE', { requester: null, sessionLabel: 'someone else' })]]) })
  await h.core.refresh({ since: 0 }, h.effect)
  assert.deepEqual(h.calls.filter(([method]) => method === 'lattice.ownerTask' || method === 'lattice.link'), [])
})

test('daemon feed: a linked row whose decision left the daemon list is still read by id', async () => {
  const answeredOld = held('K-OLDD', { status: 'answered', version: 2, answer: { optionId: 'o2', text: null, answeredAt: '2026-11-14T02:00:00Z' } })
  const records = new Map([['K-OLDD', answeredOld]])
  const cards = [{ id: 'approval-box/dec-k-oldd', plan: 'approval-box', taskId: 'dec-k-oldd', state: 'ready', lane: 'approval-box', title: 't' }]
  const row = { decisionId: 'K-OLDD', projectId: 'bellteam', plan: 'approval-box', taskId: 'dec-k-oldd', state: 'linked', attached: false, sessionLabel: 'x', handledVersion: 1, updatedAt: '2026-11-14T01:00:00Z' }
  const h = harness({ decisions: [], daemon: { keys: () => [], get: id => records.get(id) }, cards, rowsText: JSON.stringify({ version: 1, rows: [row] }) })
  await h.core.refresh({ since: 0 }, h.effect)
  assert.deepEqual([...h.writes.keys()].map(key => key.split(' ').slice(0, 2).join(' ')), ['todo start', 'todo done'])
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
  assert.throws(() => validateApprovalsEffectResult('daemon.decisions.read', { ...held('K-AAAA'), context: '本文' }), { code: 'APPROVALS_IPC_INVALID' }, 'the body text does not cross any more (a490h2)')
  assert.throws(() => validateApprovalsEffectResult('daemon.decisions.read', { ...held('K-AAAA'), attachments: [] }), { code: 'APPROVALS_IPC_INVALID' })
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

test('byTask: a linked task answers its decision from the daemon (title kept); anything else, or any failure, answers null', async () => {
  const row = { decisionId: 'K-DDDD', projectId: 'bellteam', plan: 'approval-box', taskId: 'dec-k-dddd', state: 'linked', attached: false, sessionLabel: 'x', handledVersion: 1, updatedAt: '2026-11-15T01:00:00Z' }
  const h = harness({ decisions: [], daemon: new Map([['K-DDDD', held('K-DDDD')]]), rowsText: JSON.stringify({ version: 1, rows: [row] }) })
  assert.deepEqual(await h.core.byTask({ project: 'bellteam', plan: 'approval-box', task: 'dec-k-dddd' }, h.effect), { decisionId: 'K-DDDD', status: 'pending', title: '請求を同じにするか' })
  assert.equal(await h.core.byTask({ project: 'bellteam', plan: 'approval-box', task: 'dec-none' }, h.effect), null)
  const gone = harness({ decisions: [], rowsText: JSON.stringify({ version: 1, rows: [row] }) }) // the daemon no longer holds it
  assert.equal(await gone.core.byTask({ project: 'bellteam', plan: 'approval-box', task: 'dec-k-dddd' }, gone.effect), null)
})

test('protocol: requests and effects are validated; the removed content roots are refused', () => {
  const ctx = { generation: 'g1' }
  for (const method of ['summary', 'list', 'get', 'answer', 'hold', 'unhold', 'attachment']) assert.throws(() => validateApprovalsRequest(method, {}, ctx), { code: 'APPROVALS_INVALID' }, method)
  validateApprovalsRequest('byTask', { project: 'bellteam', plan: 'approval-box', task: 'dec-k-aaaa' }, ctx)
  validateApprovalsRequest('refresh', { since: 0 }, ctx)
  validateApprovalsEffect('lattice.ownerTask', { projectId: 'bellteam', args: ['todo', 'note'], input: null })
  assert.throws(() => validateApprovalsEffect('lattice.ownerTask', { projectId: 'bellteam', args: ['todo'], input: null, from: 'owner' }))
  assert.throws(() => validateApprovalsEffect('secrets.get', {}), { code: 'APPROVALS_INVALID' })
  validateApprovalsEffectResult('session.get', null)
  validateApprovalsResult('connection', { state: 'not_connected', entitled: false, entitlement: { state: 'none' } })
  validateApprovalsResult('refresh', { seq: 0, events: [], summary: null })
  assert.throws(() => validateApprovalsResult('refresh', { seq: 0, events: [], summary: { schema: 'x' } }), { code: 'APPROVALS_IPC_INVALID' })
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
test('http: owner only; only connection, connect, by-task and by-decision are served, every removed content route is a plain 404', async () => {
  const facade = {
    connection: async () => ({ state: 'connected', entitled: true, entitlement: { state: 'paid' } }),
    byTask: async ({ task }) => task === 'dec-k-aaaa' ? { decisionId: 'K-AAAA', status: 'pending', title: 't' } : null,
    byDecision: async ({ id }) => id === 'K-AAAA' ? { project: 'bellteam', plan: 'approval-box', task: 'dec-k-aaaa', state: 'linked', attached: false } : null,
    list: async () => { throw new Error('removed') }, answer: async () => { throw new Error('removed') },
  }
  const api = createApprovalsApi({ facade, internal: false })
  const internal = createApprovalsApi({ facade, internal: true })
  assert.equal((await call(internal, 'GET', '/api/approvals/connection')).status, 403)
  assert.equal((await call(api, 'GET', '/api/other')).handled, false)
  assert.equal((await call(api, 'GET', '/api/approvals/connection')).body.state, 'connected')
  assert.equal((await call(api, 'GET', '/api/approvals/by-task?project=bellteam&plan=approval-box&task=dec-k-aaaa')).body.decisionId, 'K-AAAA')
  assert.equal((await call(api, 'GET', '/api/approvals/by-task?project=bellteam&plan=approval-box&task=nope')).status, 404)
  assert.equal((await call(api, 'GET', '/api/approvals/by-decision?id=K-AAAA')).body.state, 'linked')
  assert.equal((await call(api, 'GET', '/api/approvals/by-decision?id=bad')).status, 400)
  for (const [method, path] of [['GET', '/api/approvals'], ['GET', '/api/approvals/summary'], ['GET', '/api/approvals/events'], ['GET', '/api/approvals/K-AAAA'], ['POST', '/api/approvals/K-AAAA/answer'],
    ['POST', '/api/approvals/K-AAAA/hold'], ['POST', '/api/approvals/K-AAAA/unhold'], ['GET', '/api/approvals/K-AAAA/attachments/a1']])
    assert.deepEqual([path, (await call(api, method, path, { headers: { 'content-type': 'application/json', 'idempotency-key': 'abcdefgh-1' }, body: {} })).status], [path, 404])
})

test('module.json source lists every file of src/approval-box-extension* (the packager test pattern)', () => {
  const listed = JSON.parse(readFileSync(new URL('../docs/architecture/modules/approval-box-extension/module.json', import.meta.url), 'utf8')).source
  const files = [...readdirSync(new URL('../src/approval-box-extension', import.meta.url)).map(name => `src/approval-box-extension/${name}`),
    ...readdirSync(new URL('../src', import.meta.url)).filter(name => name.startsWith('approval-box-extension-')).map(name => `src/${name}`)]
  assert.deepEqual([...listed].sort(), files.sort())
})
