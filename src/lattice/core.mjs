import { randomUUID } from 'node:crypto'
import { checkSeatArgs } from './cli.mjs'
import { latticeError, latticeRunReads } from '../lattice-protocol.mjs'
import { laneResolver, projectChart } from './projection.mjs'
import { createCodeCharts } from './code-chart.mjs'
import { createNoticeDelivery } from './notices.mjs'
import { nudgeSweep } from './nudge.mjs'
import { ownerDecisions } from './owner-decisions.mjs'
import { stopsOf, unblockOutcome } from './blockers.mjs'

const CHART_PARALLEL = 4, STDOUT_KEPT = 64 * 1024
const iso = ms => new Date(ms).toISOString()
const parse = text => { try { return JSON.parse(text) } catch { return undefined } }

// Chart state of one child generation: a memo per chart, re-read only when its token moves or it is dirty (README State it owns, task a95).
export function createLatticeCore({ cli, now = () => Date.now(), coordinatorId = 'bot-7b140b27', refreshMs = 2000,
  log = line => process.stderr.write(line + '\n'), codeCharts = createCodeCharts({ cli, now, log }) }) {
  const epoch = randomUUID(), memos = new Map(), locks = new Map()
  // Seat runs on one chart run one at a time, so a code chart's fast-forward and sensor sync never overlap a write.
  const locked = (id, fn) => {
    const next = (locks.get(id) ?? Promise.resolve()).then(fn, fn)
    locks.set(id, next.then(() => {}, () => {}))
    return next
  }
  let roster = []
  const notices = createNoticeDelivery({ run: (id, args) => lattice(id, args), log })

  // Codes go to the diagnostic log only; the snapshot says just 'lattice-read'.
  async function lattice(id, args) {
    const result = await cli.run({ id, args, env: {} })
    if (result.exitCode !== 0) throw Object.assign(new Error('read'), { code: result.exitCode === null ? result.stderr.trim().slice(0, 64) || 'LATTICE_CLI_FAILED' : `LATTICE_CLI_EXIT_${result.exitCode}` })
    const value = parse(result.stdout)
    if (value === undefined) throw Object.assign(new Error('read'), { code: 'LATTICE_CLI_BAD_JSON' })
    return value
  }
  const source = id => cli.source(id).then(JSON.stringify, () => null)
  // Own source + each external predecessor chart's source and memo version (README L4): no time ceiling.
  async function token(id, memo) {
    const own = await source(id)
    const others = [...new Set((memo.projection?.externals ?? []).map(item => item.projectId))].sort()
    if (own === null || !others.length) return own
    const sources = await Promise.all(others.map(source))
    return sources.includes(null) ? null : JSON.stringify([own, ...others.map((other, i) => [other, sources[i], memos.get(other)?.version ?? null])])
  }

  const snapshotOf = (id, memo) => ({ schema: 'bellteam.lattice-chart.v1', epoch, version: memo.version, at: iso(now()), projectId: id, ...memo.content })
  function commit(id, memo, content) {
    const key = JSON.stringify({ ...content, verifiedAt: content.state === 'verified' ? null : content.verifiedAt })
    memo.content = content
    if (key !== memo.key) { memo.key = key; memo.version++ }
  }

  async function sync(id, members) {
    let memo = memos.get(id)
    if (!memo) memos.set(id, memo = { token: null, version: 0, key: null, content: null, projection: null, read: null, meta: null, roster: null, dirty: true, logged: null })
    const current = await token(id, memo)
    const rosterBad = await members(), rosterKey = JSON.stringify([rosterBad, roster])
    const same = memo.content && !memo.dirty && current !== null && current === memo.token
    if (same && rosterKey === memo.roster) return memo
    // A roster change alone re-projects the kept read; no CLI.
    if (same) return project(id, memo, memo.read, memo.meta, rosterBad, rosterKey)
    let read, meta
    try { [read, meta] = await Promise.all([lattice(id, ['todo', 'display', 'read', '--json']), cli.meta(id)]) } catch (error) {
      memo.dirty = true
      if (memo.logged !== error.code) { memo.logged = error.code; log(`lattice-read ${id} ${error.code ?? 'LATTICE_CLI_FAILED'}`) }
      const base = memo.content ?? { name: null, createdBy: null, coordinator: false, state: 'unavailable', verifiedAt: null, members: [], cards: [], edges: [], waits: [], phases: [] }
      commit(id, memo, { ...base, degraded: [...new Set([...base.degraded ?? [], 'lattice-read'])].sort() })
      return memo
    }
    Object.assign(memo, { token: current, dirty: false, logged: null, read, meta })
    return project(id, memo, read, meta, rosterBad, rosterKey)
  }
  function project(id, memo, read, meta, rosterBad, rosterKey) {
    // shortcut: the other chart's title/producer come from its memo as last read (none until the child reads it once); its state is Lattice's own, read now.
    const elsewhere = (projectId, cardId) => {
      const other = memos.get(projectId)?.content, card = other?.cards?.find(item => item.id === cardId)
      return other && { chartName: other.name, title: card?.title ?? null, producer: card?.producer ?? null }
    }
    const projection = projectChart({ read, members: roster, previous: memo.projection, elsewhere })
    const known = new Map(roster.filter(member => !member.deleting).map(member => [member.id, member]))
    Object.assign(memo, { projection, roster: rosterKey })
    const createdBy = meta.createdBy ?? projection.createdBy
    commit(id, memo, { name: meta.name, createdBy, coordinator: createdBy === coordinatorId, state: projection.state, verifiedAt: projection.verifiedAt,
      degraded: rosterBad ? ['members'] : [],
      members: projection.memberIds.filter(botId => known.has(botId)).map(botId => ({ botId, name: known.get(botId).name, color: known.get(botId).color,
        avatarVersion: known.get(botId).avatarVersion })),
      cards: projection.cards, edges: projection.edges, waits: projection.waits, phases: projection.phases, externals: projection.externals })
    return memo
  }

  // One roster read per root call; a failed read keeps the last roster and reports true.
  const rosterReader = effect => {
    let pending
    return () => pending ??= effect('members.list', {}).then(value => { roster = value.members; return false }, () => true)
  }
  async function syncAll(ids, effect) {
    const members = rosterReader(effect), out = []
    for (let i = 0; i < ids.length; i += CHART_PARALLEL) out.push(...await Promise.all(ids.slice(i, i + CHART_PARALLEL).map(id => sync(id, members))))
    return out
  }
  const mustExist = async id => { if (!await cli.exists(id)) throw latticeError('LATTICE_CHART_NOT_FOUND', 404) }

  return {
    epoch,
    async charts(params, effect) {
      const ids = await cli.list()
      for (const id of memos.keys()) if (!ids.includes(id)) memos.delete(id)
      const charts = (await syncAll(ids, effect)).map((memo, i) => ({ projectId: ids[i], name: memo.content.name, coordinator: memo.content.coordinator,
        createdBy: memo.content.createdBy,
        counts: memo.projection?.counts ?? { total: 0, done: 0, working: 0, waiting: 0, blocked: 0 },
        activeMembers: [...new Set(memo.content.cards.filter(card => card.state === 'in-progress' && card.producer).map(card => card.producer))].sort(),
        updatedAt: memo.projection?.updatedAt ?? null, state: memo.content.state }))
      charts.sort((a, b) => b.coordinator - a.coordinator || (b.updatedAt ? Date.parse(b.updatedAt) : -Infinity) - (a.updatedAt ? Date.parse(a.updatedAt) : -Infinity)
        || a.projectId.localeCompare(b.projectId))
      return { schema: 'bellteam.lattice-charts.v1', at: iso(now()), charts }
    },
    async chart({ projectId }, effect) {
      await mustExist(projectId)
      const [memo] = await syncAll([projectId], effect)
      return snapshotOf(projectId, memo)
    },
    // Returns each chart whose version moved since it was last returned here, so a read by another caller is never lost to subscribers.
    async refresh({ projectIds }, effect) {
      const ids = []
      // An exists() I/O error keeps the chart in the round, where its read reports degraded:['lattice-read'] instead of dropping it.
      for (const id of projectIds) if (await cli.exists(id).catch(() => true)) ids.push(id)
      const snapshots = []
      ;(await syncAll(ids, effect)).forEach((memo, i) => {
        if (memo.version !== memo.pushed) { memo.pushed = memo.version; snapshots.push(snapshotOf(ids[i], memo)) }
      })
      return { snapshots, nextRefreshMs: refreshMs }
    },
    // `name` alone (args []) only names the chart; with args it names it and then runs the command.
    // A read-only seat run on an existing chart runs beside writes: no per-chart lock, no maintenance (README L3).
    run: async (params, effect) => latticeRunReads(params) && await cli.exists(params.projectId)
      ? runOnce(params, effect, true) : locked(params.projectId, () => runOnce(params, effect)),
    // Each new child generation (parent onGeneration): unacked notices of every chart, at most NOTICE_SLICE sends.
    async deliver(params, effect) {
      const ids = await cli.list()
      await rosterReader(effect)()
      return notices.deliverAll(ids, { roster, effect, lock: locked })
    },
    // Every minute (facade timer, README L13-L15): every chart's cards from the memo -> ONE prompt per lane Bot not running.
    async nudge(params, effect) {
      const ids = await cli.list()
      const memos = await syncAll(ids, effect)
      const charts = ids.map((projectId, i) => ({ projectId, name: memos[i].content.name, createdBy: memos[i].content.createdBy, cards: memos[i].content.cards }))
      const laneOf = laneResolver(roster), live = roster.filter(member => !member.deleting)
      const out = await nudgeSweep(charts, { laneOf, log, effect })
      // Owner-lane filing (L18-L19); a failed record read or write ends this part of the tick, the next tick retries.
      let owner = { filed: 0, routed: 0 }
      try {
        owner = await ownerDecisions(charts, { laneOf, names: new Map(live.map(member => [member.id, member.name])), bots: new Set(live.map(member => member.id)),
          records: { read: () => cli.readOwnerRecord(), write: value => cli.writeOwnerRecord(value) }, effect, log })
      } catch (error) { log(`lattice-owner-record ${error?.code ?? 'FAILED'}`) }
      return { ...out, ...owner, failed: out.failed + memos.filter(memo => memo.content.degraded?.includes('lattice-read')).length }
    },
    // Owner stop list (L16): a read, so no chart lock; a chart that fails is named in unreadCharts.
    async blockers() {
      const ids = await cli.list(), rows = [], unreadCharts = []
      for (let i = 0; i < ids.length; i += CHART_PARALLEL) await Promise.all(ids.slice(i, i + CHART_PARALLEL).map(async id => {
        try {
          const [value, meta] = await Promise.all([lattice(id, ['todo', 'blockers', '--json']), cli.meta(id)])
          rows.push(...stopsOf(id, value, meta))
        } catch (error) { unreadCharts.push(id); log(`lattice-blockers ${id} ${error?.code ?? 'LATTICE_CLI_FAILED'}`) }
      }))
      const order = row => [row.projectId, row.plan, row.taskId]
      rows.sort((a, b) => order(a).join('\0').localeCompare(order(b).join('\0')))
      return { schema: 'bellteam.lattice-blockers.v1', at: iso(now()), blockers: rows, unreadCharts: unreadCharts.sort() }
    },
    // Owner unblock (L17): the only Owner write; actor 'owner' reaches LATTICE_SEAT_ID only here (named protection, README L17).
    unblock: ({ projectId, stopId }, effect) => locked(projectId, async () => {
      const answer = outcome => ({ schema: 'bellteam.lattice-unblock.v1', projectId, stopId, ...outcome })
      if (!await cli.exists(projectId)) return answer({ outcome: 'already-gone' })
      const stop = stopsOf(projectId, await lattice(projectId, ['todo', 'blockers', '--json'])).find(row => row.stopId === stopId)
      if (!stop) return answer({ outcome: 'already-gone' })
      const result = await cli.run({ id: projectId, args: ['todo', 'unblock', '--plan', stop.plan, '--task', stop.taskId, '--json'], env: { LATTICE_SEAT_ID: 'owner' }, input: null })
      const memo = memos.get(projectId)
      if (memo) memo.dirty = true
      const out = parse(result.stdout)
      if (result.exitCode === 0 && effect) {
        // The messenger refuses 'owner' as a sender, so released notices go out from 'scheduler'.
        try { await rosterReader(effect)(); await notices.afterRun(projectId, out, { from: 'scheduler', roster, effect }) } catch (error) { log(`lattice-notice ${projectId} ${error?.code ?? 'FAILED'}`) }
      }
      return answer(unblockOutcome({ exitCode: result.exitCode, out, err: parse(result.stderr) }))
    }),
  }
  async function runOnce({ from, projectId, args, input, name }, effect, read = false) {
    const naming = name !== undefined
    const renameOnly = naming && args.length === 0 && input === null
    if (!renameOnly) checkSeatArgs(args, input)
    // Renaming needs a chart; only a Lattice command (plan create) makes one.
    else await mustExist(projectId)
    const existed = await cli.exists(projectId)
    const { created } = read ? { created: false } : await cli.ensure(projectId)
    // The creator is recorded once: by the run that makes the store, or by naming a chart that has none recorded.
    if (naming) await cli.setMeta(projectId, { name, ...(existed && !(await cli.meta(projectId)).createdBy && { createdBy: from }) })
    const memo = memos.get(projectId)
    if (memo && !read) memo.dirty = true
    if (args.length === 0) return { exitCode: 0, result: { name }, stdout: null, stderr: '' }
    if (!read) await codeCharts.maintain(projectId)
    let result
    try { result = await cli.run({ id: projectId, args, env: { LATTICE_SEAT_ID: from }, input }) } finally {
      // Only a dir this run created is removed; a pre-existing dir without a store is left as it was.
      if (!existed) { if (await cli.exists(projectId)) await cli.setMeta(projectId, { createdBy: from }); else if (created) await cli.prune(projectId) }
    }
    // Lattice prints refusals (lattice.cli_error.v2: code, detail.pointer, detail.next_action) on stderr; they reach the seat as result.
    // undefined = not JSON; a valid JSON null on stdout stays the result.
    const out = parse(result.stdout)
    const value = out !== undefined ? out : result.stdout.trim() === '' ? parse(result.stderr) : undefined
    // Delivery never changes the seat's result; its failures stay unacked in Lattice and are re-listed later.
    // A seat's own `todo notice list|ack` is not a release write: its notices are that seat's reading, never sent or acked here.
    if (effect && !read && result.exitCode === 0 && !(args[0] === 'todo' && args[1] === 'notice')) {
      try { await rosterReader(effect)(); await notices.afterRun(projectId, value, { from, roster, effect }) } catch (error) { log(`lattice-notice ${projectId} ${error?.code ?? 'FAILED'}`) }
    }
    return { exitCode: result.exitCode, result: value === undefined ? null : value, stdout: value === undefined ? result.stdout.slice(0, STDOUT_KEPT) : null, stderr: result.stderr }
  }
}
