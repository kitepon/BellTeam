// Approval Box extension: the child core (README F1-F7). Roots are the contract's calls; `refresh` is the engine tick, because effects exist only
// inside a root call. The extension copies no decision: ids and state go to links.json, everything else is read from Approval Box on demand.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createApprovalBoxClient } from './client.mjs'
import { toViewDecision, summarize } from './origin-view.mjs'
import { entitlementFrom, cacheMillis } from './entitlement.mjs'
import { nextConnect } from './connect-state.mjs'
import { planLink, targetChart, DECISION_PLAN, DECISION_LANE } from './link-plan.mjs'
import { WITHDRAW_REASON } from './owner-lane.mjs'
import { planRelay, relayAccepted, RELAY_ROW_KEEP_MS, RELAY_FEATURE_START } from './answer-relay.mjs'
import { approvalsError } from '../approval-box-extension-protocol.mjs'

export const STATE_DIR = '/srv/bellteam/state/approval-box-extension'
const fail = (code, status) => approvalsError(code, status)
const ROW_KEEP_MS = 30 * 86_400_000, RING = 200, PER_TICK = 5, CATCH_UP_MS = 5 * 60_000, ROSTER_MS = 60_000, OWNER_SCAN_MS = 60_000
const fileOps = {
  read: async path => readFile(path, 'utf8').catch(error => (error.code === 'ENOENT' ? null : Promise.reject(error))),
  write: async (path, text) => { await mkdir(join(path, '..'), { recursive: true, mode: 0o700 }); await writeFile(`${path}.tmp`, text, { mode: 0o600 }); await rename(`${path}.tmp`, path) },
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const JST = 9 * 3_600_000
const sameJstDay = (iso, now) => typeof iso === 'string' && Math.floor((Date.parse(iso) + JST) / 86_400_000) === Math.floor((now + JST) / 86_400_000)
// shortcut: a refused-because-it-exists Lattice code is read by its name; widen if Lattice names a duplicate differently.
const existsAlready = result => /EXIST|ALREADY|UNCHANGED/iu.test(result?.code ?? '')

export function createApprovalBoxExtensionCore({ client = createApprovalBoxClient(), now = Date.now, stateDir = STATE_DIR, files = fileOps, streamBackoffMs = 1000 } = {}) {
  let session, unsaved = false, rows = null, pairing = null, connectState = 'not_connected', entitlement = null, entitlementAt = 0, roster = null, rosterAt = 0
  let lastOwnerScan = -Infinity
  let seq = 0, ring = [], dirty = new Set(), caughtUp = false, lastCatchUp = 0, stream = null, sessionInvalid = false, lastEventId = null
  const rowsPath = join(stateDir, 'links.json'), bookPath = join(stateDir, 'answers.json')
  let book = null

  const loadRows = async () => {
    if (rows) return rows
    const text = await files.read(rowsPath)
    const parsed = text ? JSON.parse(text) : null
    rows = (parsed?.rows ?? []).filter(row => !(row.state === 'answered' || row.state === 'closed') || now() - Date.parse(row.updatedAt) < ROW_KEEP_MS)
    return rows
  }
  const saveRows = () => files.write(rowsPath, `${JSON.stringify({ version: 1, rows })}\n`)
  // F8 ledger: since = the first time this file was written, so a first install never replays old answers (README section 13, A2).
  const loadBook = () => (bookLoading ??= readBook()).then(() => book) // the promise memoizes the first read only; relay replaces `book`
  const readBook = async () => {
    const text = await files.read(bookPath)
    const parsed = text ? JSON.parse(text) : null
    // Ledgers of version 1 were created at the first entitled tick, which on a closed gate (Owner account read expired, 11/27) was hours after install and hid the answers made meanwhile: one-time move back to the release date.
    const migrate = parsed && parsed.version !== 2
    book = { since: migrate ? RELAY_FEATURE_START : parsed?.since ?? new Date(now()).toISOString(), rows: (parsed?.rows ?? []).filter(row => now() - Date.parse(row.at) < RELAY_ROW_KEEP_MS) }
    if (!parsed || migrate) await saveBook()
    return book
  }
  let bookLoading = null
  const saveBook = () => files.write(bookPath, `${JSON.stringify({ ...book, version: 2 })}\n`)
  // One message to the asking seat through BellTeam's normal delivery; the row is written only once the parent says it was taken (A4).
  const relay = async (effect, d) => {
    const current = await loadBook(), plan = planRelay(d, current, now())
    if (!plan) return
    const sent = await effect('seat.message', { target: plan.target, message: plan.message })
    if (!relayAccepted(sent.delivery) && sent.delivery !== 'refused') throw fail('APPROVALS_EFFECT_FAILED', 503)
    book = { ...current, rows: [...current.rows, { decisionId: d.id, delivery: sent.delivery, deliveryId: sent.deliveryId, at: new Date(now()).toISOString() }] }
    await saveBook()
    process.stderr.write(`approval-box-extension relay ${d.id} ${sent.delivery}\n`)
  }

  // ---- connection (F7): the session lives in the usage secret store (R7); this process keeps it in memory only
  const loadSession = async effect => {
    if (session !== undefined) return
    const found = await effect('session.get', {})
    try { session = found ? JSON.parse(found.value) : null } catch { session = null }
    if (session && !session.token) session = null
  }
  const adoptPairing = async effect => {
    if (!pairing?.claimed) return
    const claimed = pairing.claimed
    pairing = null
    session = { token: claimed.session, expiresAt: claimed.expires_at ?? null }
    connectState = 'connected'; entitlement = null; entitlementAt = 0; sessionInvalid = false; caughtUp = false
    unsaved = true; await saveSession(effect) // a failed put never loses the one-time session: it stays in memory and is saved again on every later root
  }
  // shortcut: one extra effect per root while the store refuses, not a backoff; upgrade if the store gets slow (a198)
  const saveSession = async effect => {
    if (!unsaved || !session) return
    try { await effect('session.put', { value: JSON.stringify(session) }); unsaved = false } catch { /* keep unsaved, retry next root */ }
  }
  const dropSession = async effect => {
    stopStream()
    const had = session
    session = null; unsaved = false; entitlement = null; sessionInvalid = false
    connectState = nextConnect(had ? 'connected' : connectState, { type: 'unauthorized' }).state
    await effect('session.erase', {}).catch(() => {})
  }
  const ready = async effect => { await loadSession(effect); await adoptPairing(effect); await saveSession(effect); if (sessionInvalid) await dropSession(effect) }

  const abx = async (effect, method, path, options) => {
    const response = await client.call(session.token, method, path, options)
    if (response.status === 401) { await dropSession(effect); throw fail('APPROVALS_NOT_CONNECTED', 409) }
    return response
  }
  const mapped = response => {
    const { status } = response
    if (status === 402) return fail('APPROVALS_SUBSCRIPTION_EXPIRED', 402)
    if (status === 404) return fail('APPROVALS_NOT_FOUND', 404)
    if (status === 429) return fail('APPROVALS_RATE_LIMITED', 429)
    if (status === 400) return Object.assign(fail('APPROVALS_VALIDATION_FAILED', 400), { detail: response.json?.error?.message })
    return fail('APPROVALS_UNAVAILABLE', 503)
  }

  // ---- entitlement (F6, R4): positive 5 min, negative 1 min; unknown keeps the last result
  const readEntitlement = async effect => {
    if (!session) return entitlementFrom(null, { now: now(), credential: false })
    if (entitlement && now() - entitlementAt < cacheMillis(entitlement)) return entitlement
    let next
    try {
      const response = await abx(effect, 'GET', '/v1/me')
      next = entitlementFrom(response.status === 200 ? response.json : null, { now: now(), reachable: response.status === 200, previous: entitlement })
    } catch (error) {
      if (error.code === 'APPROVALS_NOT_CONNECTED') return entitlementFrom(null, { now: now(), credential: false })
      next = entitlementFrom(null, { now: now(), reachable: false, previous: entitlement })
    }
    entitlement = next; entitlementAt = now()
    return next
  }
  const gate = async effect => {
    await ready(effect)
    if (!session) throw fail('APPROVALS_NOT_CONNECTED', 409)
    const result = await readEntitlement(effect)
    if (!session) throw fail('APPROVALS_NOT_CONNECTED', 409)
    if (!result.entitled) throw fail('APPROVALS_NOT_ENTITLED', 403)
  }

  const members = async effect => {
    if (!roster || now() - rosterAt > ROSTER_MS) { roster = await effect('members.list', {}).catch(() => roster ?? []); rosterAt = now() }
    return roster
  }

  // ---- link view of one decision: read from the link record and the Lattice facade at call time, never stored
  const linkView = async (row, effect, memo) => {
    if (!row) return null
    try {
      memo.charts ??= await effect('lattice.charts', {})
      const chart = memo[row.projectId] ??= await effect('lattice.chart', { projectId: row.projectId })
      const id = `${row.plan}/${row.taskId}`, card = chart.cards.find(item => item.id === id)
      if (!card) return null
      const side = (from, to) => chart.edges.filter(edge => edge[from] === id).map(edge => chart.cards.find(item => item.id === edge[to])).filter(Boolean)
        .map(item => ({ title: item.title, state: item.state, cardId: item.id }))
      const meta = memo.charts.find(item => item.projectId === row.projectId)
      return { state: row.state, attached: row.attached, chart: { name: meta?.name ?? 'ほかの工程表', projectId: row.projectId },
        task: { title: card.title, state: card.state, lane: card.lane, cardId: id }, previous: side('to', 'from'), next: side('from', 'to') }
    } catch { return null }
  }
  const view = async (decision, effect, memo = {}) => {
    const list = await loadRows()
    const sent = (await loadBook()).rows.find(row => row.decisionId === decision.id)
    return toViewDecision(decision, { roster: await members(effect), link: await linkView(list.find(row => row.decisionId === decision.id), effect, memo), relayed: relayAccepted(sent?.delivery) })
  }
  const read = async (effect, id) => {
    const response = await abx(effect, 'GET', `/v1/decisions/${id}`)
    if (response.status !== 200) throw mapped(response)
    return response.json
  }
  // One decision for the engine, read from /v1; an id /v1 does not know is null (the engine then treats it as gone).
  const readEngine = (effect, id) => read(effect, id).catch(error => { if (error.code === 'APPROVALS_NOT_FOUND') return null; throw error })

  const summaryOf = async effect => {
    const decisions = []
    for (const status of ['pending,held', 'answered']) {
      let cursor = null
      for (let page = 0; page < (status === 'answered' ? 1 : 5); page++) {
        const response = await abx(effect, 'GET', `/v1/decisions?status=${status}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
        if (response.status !== 200) throw mapped(response)
        decisions.push(...response.json.items)
        if (!(cursor = response.json.next_cursor)) break
      }
    }
    return summarize(decisions, { roster: await members(effect), today: iso => sameJstDay(iso, now()) })
  }

  // ---- Approval Box events held by the child (SSE), buffered with a sequence number
  const stopStream = () => { stream?.abort(); stream = null }
  const ensureStream = () => {
    if (stream || !session) return
    const controller = new AbortController(), token = session.token
    stream = controller
    void (async () => {
      let backoff = streamBackoffMs
      while (!controller.signal.aborted) {
        try {
          for await (const item of client.events({ token, lastEventId, signal: controller.signal })) {
            backoff = streamBackoffMs
            if (item.id) lastEventId = item.id
            if (!/^decision\.(created|updated|deleted)$/u.test(item.event)) continue
            const data = JSON.parse(item.data)
            ring.push({ seq: ++seq, type: item.event, id: data.decision_id, version: data.version ?? 0 })
            if (ring.length > RING) ring.shift()
          }
        } catch (error) { if (error?.status === 401) { sessionInvalid = true; stream = null; return } }
        if (controller.signal.aborted) return
        caughtUp = false // a gap: read the list once more
        await sleep(backoff); backoff = Math.min(backoff * 2, 30_000)
      }
    })()
  }

  // ---- link engine: one decision at a time, idempotent; a failed step keeps the id for the next tick
  const execute = async (effect, plan) => {
    const owner = (projectId, args, input = null) => effect('lattice.ownerTask', { projectId, args, input }).then(result => {
      if (result.exitCode !== 0 && !existsAlready(result.result)) throw fail('APPROVALS_EFFECT_FAILED', 503)
    })
    for (let i = 0; i < plan.actions.length; i++) {
      const action = plan.actions[i]
      if (action.op === 'link') await effect('lattice.link', { projectId: action.projectId, plan: action.plan, taskId: action.taskId })
      else if (action.op === 'ensurePlan') {
        // The first decision task rides in `plan create` itself (a plan may not be empty); the planner's `todo add` for it is then skipped.
        const add = plan.actions[++i].args, at = name => add[add.indexOf(name) + 1]
        await owner(action.projectId, ['plan', 'create', '--json'], { schema: 'lattice.plan_create_input.v5', plan_key: DECISION_PLAN, phases: [{ phase_id: 'decisions', title: '決裁箱の決裁' }],
          tasks: [{ task_id: at('--task'), title: at('--title'), phase_id: 'decisions', design_memo: at('--design-memo'), lane: DECISION_LANE }], hard_dependencies: [] })
      } else await owner(action.projectId, action.args)
    }
  }
  const process_ = async (effect, id, memo) => {
    const decision = await readEngine(effect, id)
    if (!decision) return
    const d = toViewDecision(decision, { roster: await members(effect) })
    // The answer goes first and independently: a Lattice step that fails every tick (chart busy, task refused) must never keep the seat from its answer. Each failure keeps the id for the next tick.
    let relayFailure = null
    try { await relay(effect, d) } catch (error) { relayFailure = error; process.stderr.write(`approval-box-extension relay ${id} ${error?.code ?? 'FAILED'}\n`) }
    await link_(effect, id, d, memo)
    if (relayFailure) throw relayFailure
  }
  const link_ = async (effect, id, d, memo) => {
    const list = await loadRows(), row = list.find(item => item.decisionId === id) ?? null
    let projectId = row?.projectId
    if (!projectId) {
      if (d.status !== 'pending' && d.status !== 'held') return
      projectId = targetChart(d, await effect('lattice.charts', {}))
      if (!projectId) return
    }
    const chart = { projectId, ...(memo[projectId] ??= await effect('lattice.chart', { projectId })) }
    const plan = planLink({ d, row, rows: list, chart })
    if (!plan.actions.length && !plan.row) return
    try { await execute(effect, plan) } catch (error) { if (error?.code === 'APPROVALS_EFFECT_REFUSED') return; throw error }
    delete memo[projectId] // the chart changed
    if (plan.row) {
      const next = { ...plan.row, updatedAt: new Date(now()).toISOString() }
      rows = [...list.filter(item => item.decisionId !== id), next]
      await saveRows()
    }
  }

  const catchUp = async effect => {
    const list = await loadRows()
    for (const status of ['pending,held']) {
      let cursor = null
      for (let page = 0; page < 5; page++) {
        const response = await abx(effect, 'GET', `/v1/decisions?status=${status}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
        if (response.status !== 200) throw mapped(response)
        response.json.items.forEach(item => dirty.add(item.id))
        if (!(cursor = response.json.next_cursor)) break
      }
    }
    // F8: answers made while the child was down or the stream had a gap (the first page of answered is enough: A2 keeps only the last 24 h).
    const { since } = await loadBook()
    // Best effort: this list only adds ids, so a refusal here (rate limit, outage) must not stop the pending/held catch-up below. A 401 still ends the tick (abx drops the session).
    const answered = await abx(effect, 'GET', '/v1/decisions?status=answered&limit=100').catch(error => { if (error?.code === 'APPROVALS_NOT_CONNECTED') throw error; return { status: 0 } })
    if (answered.status === 200) answered.json.items.filter(item => Date.parse(item.answer?.answered_at) >= Date.parse(since) && !book.rows.some(row => row.decisionId === item.id)).forEach(item => dirty.add(item.id))
    list.filter(row => row.state === 'linked' || row.state === 'diverged').forEach(row => dirty.add(row.decisionId))
    caughtUp = true; lastCatchUp = now()
  }

  // F9 withdrawal (README section 5b): the module never writes a card itself (Owner 2026-11-28, 「機械が出すんじゃなくて工程作ったやつが真面目に俺にお願いしろ」).
  // A row it filed earlier (filed: true, machine-written text the Owner cannot read) is cancelled and dropped, once. Unavailable keeps the row for the next scan; a refusal (already answered) drops it.
  const ownerScan = async effect => {
    if (now() - lastOwnerScan < OWNER_SCAN_MS) return
    lastOwnerScan = now()
    for (const row of (await loadRows()).filter(item => item.filed).slice(0, 10)) {
      try { await effect('decisions.cancel', { decisionId: row.decisionId, reason: WITHDRAW_REASON }) } catch (error) { if (error?.code !== 'APPROVALS_EFFECT_REFUSED') return }
      rows = (await loadRows()).filter(item => item !== row)
      await saveRows()
    }
  }

  const connection = async effect => {
    await ready(effect)
    const result = entitlement ?? entitlementFrom(null, { now: now(), credential: Boolean(session), reachable: false }) // never a network call: the exchange probe must not wait on Approval Box
    return { state: session ? 'connected' : pairing ? pairing.status : connectState === 'connected' ? 'not_connected' : connectState, entitled: session ? result.entitled : false, entitlement: result,
      ...(session?.expiresAt ? { expiresAt: session.expiresAt } : {}) }
  }
  const pollLoop = async current => {
    let backoff = 1000
    while (pairing === current && current.status === 'waiting') {
      try {
        const answer = await client.pollPairing(current.id, current.pollSecret)
        backoff = 1000
        if (pairing !== current) return
        const step = nextConnect('waiting', { type: 'poll', status: answer.status })
        connectState = step.state
        if (answer.status === 'claimed') { current.claimed = { session: answer.session, expires_at: answer.expires_at }; return }
        if (step.state === 'denied') { current.status = 'denied'; return }
        if (step.state !== 'waiting') { pairing = null; return }
      } catch { await sleep(backoff); backoff = Math.min(backoff * 2, 30_000); if (Date.parse(current.expiresAt) < now()) { if (pairing === current) { pairing = null; connectState = 'not_connected' } return } }
    }
  }

  return {
    connection: (params, effect) => connection(effect),
    async connect(params, effect) {
      await ready(effect)
      if (pairing?.status === 'waiting' && Date.parse(pairing.expiresAt) > now()) return { authorizationUrl: pairing.url, expiresAt: pairing.expiresAt }
      const started = await client.startPairing()
      pairing = { id: started.pairing_id, pollSecret: started.poll_secret, url: started.qr_url, expiresAt: started.expires_at, status: 'waiting', claimed: null }
      connectState = nextConnect(connectState, { type: 'start' }).state
      void pollLoop(pairing)
      return { authorizationUrl: pairing.url, expiresAt: pairing.expiresAt }
    },
    async cancelConnect(params, effect) { pairing = null; connectState = nextConnect(connectState, { type: 'cancel' }).state; return connection(effect) },
    async disconnect(params, effect) {
      await ready(effect)
      pairing = null; stopStream(); session = null; unsaved = false; entitlement = null; connectState = 'not_connected'
      await effect('session.erase', {})
      return connection(effect)
    },
    async summary(params, effect) { await gate(effect); return summaryOf(effect) },
    async list({ status, origin, cursor, limit = 50 }, effect) {
      await gate(effect)
      const response = await abx(effect, 'GET', `/v1/decisions?status=${status.join(',')}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      if (response.status !== 200) throw mapped(response)
      const memo = {}, items = []
      for (const decision of response.json.items) items.push(await view(decision, effect, memo))
      return { items: origin ? items.filter(item => (item.origin.kind === 'bellteam') === (origin === 'bellteam')) : items, ...(response.json.next_cursor ? { nextCursor: response.json.next_cursor } : {}) }
    },
    async get({ id }, effect) {
      await gate(effect)
      return view(await read(effect, id), effect)
    },
    async answer({ id, optionId, text, version, idempotencyKey }, effect) {
      await gate(effect)
      const response = await abx(effect, 'POST', `/v1/decisions/${id}/answer`, { json: { ...(optionId === undefined ? { text } : { option_id: optionId }), version }, headers: { 'idempotency-key': idempotencyKey } })
      if (response.status === 409 && response.json?.error?.decision) return { outcome: 'conflict', decision: await view(response.json.error.decision, effect) }
      if (response.status !== 200) throw mapped(response)
      dirty.add(id) // the answer goes first; the task follows on the next tick
      return { outcome: 'answered', decision: await view(response.json, effect) }
    },
    async hold({ id }, effect) { await gate(effect); return hold(effect, id, 'hold') },
    async unhold({ id }, effect) { await gate(effect); return hold(effect, id, 'unhold') },
    async attachment({ id, aid }, effect) {
      await gate(effect)
      const response = await abx(effect, 'GET', `/v1/decisions/${id}/attachments/${aid}`, { raw: true })
      if (response.status !== 200) throw mapped(response)
      return { contentType: response.headers.get('content-type') ?? 'application/octet-stream', size: response.bytes.length, etag: response.headers.get('etag'), data: response.bytes.toString('base64') }
    },
    async byTask({ project, plan, task }, effect) {
      try {
        await gate(effect)
        const row = (await loadRows()).find(item => item.projectId === project && item.plan === plan && item.taskId === task)
        if (!row) return null
        const decision = await read(effect, row.decisionId)
        return { decisionId: decision.id, status: decision.status, title: decision.title }
      } catch { return null } // any failure draws no block
    },
    // a490g: ids and state only, for the apps' 「工程とのつながり」 panel and badge (peer-channel-feed.md section 5); no Approval Box call, so it works after the content routes close.
    async byDecision({ id }, effect) {
      try {
        await gate(effect)
        const row = (await loadRows()).find(item => item.decisionId === id)
        return row ? { project: row.projectId, plan: row.plan, task: row.taskId, state: row.state, attached: Boolean(row.attached) } : null
      } catch { return null } // any failure draws no badge
    },
    async refresh({ since }, effect) {
      await ready(effect)
      await loadBook() // the ledger starts at the first tick after install, never at the first entitled tick (A2)
      const idle = { seq, events: [], summary: null }
      if (!session) return idle
      if (!(await readEntitlement(effect)).entitled) return idle
      ensureStream()
      const fresh = ring.filter(event => event.seq > since)
      fresh.forEach(event => dirty.add(event.id))
      const catching = !caughtUp || now() - lastCatchUp > CATCH_UP_MS
      if (catching) await catchUp(effect)
      const memo = {}
      for (const id of [...dirty].slice(0, PER_TICK)) {
        try { await process_(effect, id, memo); dirty.delete(id) } catch (error) { if (error?.code === 'APPROVALS_NOT_CONNECTED') return idle; dirty.delete(id); dirty.add(id) } // a failing id goes to the back so five stuck ones cannot starve the rest
      }
      // F9 runs once every decision Approval Box lists has been linked (an AI's own request with the card's label is attached by L8 first: no second request); an id that keeps failing holds it for 2 minutes after a catch-up at most.
      if (!dirty.size || now() - lastCatchUp > 2 * 60_000) await ownerScan(effect).catch(error => { if (error?.code === 'APPROVALS_NOT_CONNECTED') throw error; process.stderr.write(`approval-box-extension owner-lane ${error?.code ?? 'FAILED'}\n`) })
      return { seq, events: fresh.map(({ type, id, version }) => ({ type, id, version })), summary: fresh.length || since === 0 ? await summaryOf(effect).catch(() => null) : null }
    },
  }
  async function hold(effect, id, verb) {
    const response = await abx(effect, 'POST', `/v1/decisions/${id}/${verb}`, { headers: { 'idempotency-key': crypto.randomUUID() } })
    if (response.status !== 200) throw mapped(response)
    return view(response.json, effect)
  }
}
