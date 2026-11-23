// Approval Box extension: the child core (README F1-F7). Roots are the contract's calls; `refresh` is the engine tick, because effects exist only
// inside a root call. The extension copies no decision: ids and state go to links.json, everything else is read from Approval Box on demand.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createApprovalBoxClient } from './client.mjs'
import { toViewDecision } from './origin-view.mjs'
import { entitlementFrom, cacheMillis } from './entitlement.mjs'
import { nextConnect } from './connect-state.mjs'
import { planLink, targetChart, DECISION_PLAN, DECISION_LANE } from './link-plan.mjs'
import { approvalsError } from '../approval-box-extension-protocol.mjs'

export const STATE_DIR = '/srv/bellteam/state/approval-box-extension'
const fail = (code, status) => approvalsError(code, status)
const ROW_KEEP_MS = 30 * 86_400_000, PER_TICK = 5, CATCH_UP_MS = 5 * 60_000, ROSTER_MS = 60_000
const fileOps = {
  read: async path => readFile(path, 'utf8').catch(error => (error.code === 'ENOENT' ? null : Promise.reject(error))),
  write: async (path, text) => { await mkdir(join(path, '..'), { recursive: true, mode: 0o700 }); await writeFile(`${path}.tmp`, text, { mode: 0o600 }); await rename(`${path}.tmp`, path) },
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// shortcut: a refused-because-it-exists Lattice code is read by its name; widen if Lattice names a duplicate differently.
const existsAlready = result => /EXIST|ALREADY|UNCHANGED/iu.test(result?.code ?? '')

export function createApprovalBoxExtensionCore({ client = createApprovalBoxClient(), now = Date.now, stateDir = STATE_DIR, files = fileOps } = {}) {
  let session, unsaved = false, rows = null, pairing = null, connectState = 'not_connected', entitlement = null, entitlementAt = 0, roster = null, rosterAt = 0
  let dirty = new Set(), caughtUp = false, lastCatchUp = 0
  const rowsPath = join(stateDir, 'links.json')

  const loadRows = async () => {
    if (rows) return rows
    const text = await files.read(rowsPath)
    const parsed = text ? JSON.parse(text) : null
    rows = (parsed?.rows ?? []).filter(row => !(row.state === 'answered' || row.state === 'closed') || now() - Date.parse(row.updatedAt) < ROW_KEEP_MS)
    return rows
  }
  const saveRows = () => files.write(rowsPath, `${JSON.stringify({ version: 1, rows })}\n`)

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
    connectState = 'connected'; entitlement = null; entitlementAt = 0; caughtUp = false
    unsaved = true; await saveSession(effect) // a failed put never loses the one-time session: it stays in memory and is saved again on every later root
  }
  // shortcut: one extra effect per root while the store refuses, not a backoff; upgrade if the store gets slow (a198)
  const saveSession = async effect => {
    if (!unsaved || !session) return
    try { await effect('session.put', { value: JSON.stringify(session) }); unsaved = false } catch { /* keep unsaved, retry next root */ }
  }
  const dropSession = async effect => {
    const had = session
    session = null; unsaved = false; entitlement = null
    connectState = nextConnect(had ? 'connected' : connectState, { type: 'unauthorized' }).state
    await effect('session.erase', {}).catch(() => {})
  }
  const ready = async effect => { await loadSession(effect); await adoptPairing(effect); await saveSession(effect) }

  const abx = async (effect, method, path, options) => {
    const response = await client.call(session.token, method, path, options)
    if (response.status === 401) { await dropSession(effect); throw fail('APPROVALS_NOT_CONNECTED', 409) }
    return response
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

  // a490g (peer-channel-feed.md): decisions held by the hosted daemon, read through the parent. The daemon record is mapped to the /v1 Decision shape the planner already reads;
  // it carries no context, attachments or history (the apps show decisions from their device session) (so no L4 amend note from this source), and no requester_bot_id: the roster-name match classifies it (README, shortcut).
  const fromDaemon = rec => ({ id: rec.id, title: rec.title, context: '', options: rec.options, urgency: rec.urgency, ...(rec.deadline ? { deadline: rec.deadline } : {}), status: rec.status,
    answer: rec.answer && { option_id: rec.answer.optionId, text: rec.answer.text, answered_at: rec.answer.answeredAt }, version: rec.version, created_at: rec.createdAt, updated_at: rec.updatedAt,
    cancel_reason: rec.cancelReason, ...(rec.recommendation ? { recommendation: rec.recommendation } : {}), resume_phrase: '', history: [], request_attachments: [],
    source: { client: 'other', session_label: rec.sessionLabel, ...(rec.requester ? { requester: rec.requester } : {}) } })
  const readDaemon = async (effect, id) => { const rec = await effect('daemon.decisions.read', { id }).catch(() => null); return rec ? fromDaemon(rec) : null }
  // After the /v1 content close (a490h2) the hosted daemon is the only source of decisions: the engine reads each id from it (a closed decision stays readable by id 30 days after its last update).
  const readEngine = readDaemon

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
    const list = await loadRows(), row = list.find(item => item.decisionId === id) ?? null
    const d = toViewDecision(decision, { roster: await members(effect) })
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
    // What BellTeam's seats and the body filed into the hosted daemon (empty until it is paired or when the parent cannot read it).
    const held = await effect('daemon.decisions.list', {}).catch(() => [])
    held.forEach(item => dirty.add(item.id))
    list.filter(row => row.state === 'linked' || row.state === 'diverged').forEach(row => dirty.add(row.decisionId))
    caughtUp = true; lastCatchUp = now()
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
      pairing = null; session = null; unsaved = false; entitlement = null; connectState = 'not_connected'
      await effect('session.erase', {})
      return connection(effect)
    },
    async byTask({ project, plan, task }, effect) {
      try {
        await gate(effect)
        const row = (await loadRows()).find(item => item.projectId === project && item.plan === plan && item.taskId === task)
        if (!row) return null
        const decision = await readDaemon(effect, row.decisionId)
        return decision ? { decisionId: decision.id, status: decision.status, title: decision.title } : null
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
    async refresh(params, effect) {
      await ready(effect)
      const idle = { seq: 0, events: [], summary: null }
      if (!session) return idle
      if (!(await readEntitlement(effect)).entitled) return idle
      if (!caughtUp || now() - lastCatchUp > CATCH_UP_MS) await catchUp(effect)
      const memo = {}
      for (const id of [...dirty].slice(0, PER_TICK)) {
        try { await process_(effect, id, memo); dirty.delete(id) } catch (error) { if (error?.code === 'APPROVALS_NOT_CONNECTED') return idle; dirty.delete(id); dirty.add(id) } // a failing id goes to the back so five stuck ones cannot starve the rest
      }
      return idle // no events and no summary any more: the apps count from their device session
    },
  }
}
