import { randomUUID } from 'node:crypto'
import { checkSeatArgs } from './cli.mjs'
import { latticeError } from '../lattice-protocol.mjs'
import { projectChart } from './projection.mjs'

const CHART_PARALLEL = 4, STDOUT_KEPT = 64 * 1024
const iso = ms => new Date(ms).toISOString()
const parse = text => { try { return JSON.parse(text) } catch { return undefined } }

// Chart state of one child generation: a memo per chart, refreshed only when Lattice's source token moves (or after a run, or at the ceiling).
export function createLatticeCore({ cli, now = () => Date.now(), coordinatorId = 'bot-7b140b27', ceilingMs = 30000, refreshMs = 2000,
  log = line => process.stderr.write(line + '\n') }) {
  const epoch = randomUUID(), memos = new Map()
  let roster = []

  // Codes go to the diagnostic log only; the snapshot says just 'lattice-read'.
  async function lattice(id, args) {
    const result = await cli.run({ id, args, env: {} })
    if (result.exitCode !== 0) throw Object.assign(new Error('read'), { code: result.exitCode === null ? result.stderr.trim().slice(0, 64) || 'LATTICE_CLI_FAILED' : `LATTICE_CLI_EXIT_${result.exitCode}` })
    const value = parse(result.stdout)
    if (value === undefined) throw Object.assign(new Error('read'), { code: 'LATTICE_CLI_BAD_JSON' })
    return value
  }
  const token = id => lattice(id, ['todo', 'display', 'source', '--json']).then(JSON.stringify, () => null)

  const snapshotOf = (id, memo) => ({ schema: 'bellteam.lattice-chart.v1', epoch, version: memo.version, at: iso(now()), projectId: id, ...memo.content })
  function commit(id, memo, content) {
    const key = JSON.stringify({ ...content, verifiedAt: content.state === 'verified' ? null : content.verifiedAt })
    memo.content = content
    if (key !== memo.key) { memo.key = key; memo.version++ }
  }

  async function sync(id, members) {
    let memo = memos.get(id)
    if (!memo) memos.set(id, memo = { token: null, readAt: 0, version: 0, key: null, content: null, projection: null, dirty: true, logged: null })
    const current = await token(id)
    if (memo.content && !memo.dirty && current !== null && current === memo.token && now() - memo.readAt < ceilingMs) return memo
    let read, name
    try { [read, name] = await Promise.all([lattice(id, ['todo', 'display', 'read', '--json']), cli.name(id)]) } catch (error) {
      memo.dirty = true
      if (memo.logged !== error.code) { memo.logged = error.code; log(`lattice-read ${id} ${error.code ?? 'LATTICE_CLI_FAILED'}`) }
      const base = memo.content ?? { name: null, createdBy: null, coordinator: false, state: 'unavailable', verifiedAt: null, members: [], cards: [], edges: [], waits: [] }
      commit(id, memo, { ...base, degraded: [...new Set([...base.degraded ?? [], 'lattice-read'])].sort() })
      return memo
    }
    const rosterBad = await members()
    const projection = projectChart({ read, members: roster, previous: memo.projection })
    const known = new Map(roster.filter(member => !member.deleting).map(member => [member.id, member]))
    Object.assign(memo, { token: current, readAt: now(), dirty: false, logged: null, projection })
    commit(id, memo, { name, createdBy: projection.createdBy, coordinator: projection.createdBy === coordinatorId, state: projection.state, verifiedAt: projection.verifiedAt,
      degraded: rosterBad ? ['members'] : [],
      members: projection.memberIds.filter(botId => known.has(botId)).map(botId => ({ botId, name: known.get(botId).name, color: known.get(botId).color,
        avatarVersion: known.get(botId).avatarVersion })),
      cards: projection.cards, edges: projection.edges, waits: projection.waits })
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
    async run({ from, projectId, args, input, name }) {
      const naming = name !== undefined
      const renameOnly = naming && args.length === 0 && input === null
      if (!renameOnly) checkSeatArgs(args, input)
      // Renaming needs a chart; only a Lattice command (plan create) makes one.
      else await mustExist(projectId)
      await cli.ensure(projectId)
      if (naming) await cli.setName(projectId, name)
      const memo = memos.get(projectId)
      if (memo) memo.dirty = true
      if (args.length === 0) return { exitCode: 0, result: { name }, stdout: null, stderr: '' }
      const result = await cli.run({ id: projectId, args, env: { LATTICE_SEAT_ID: from }, input })
      const value = parse(result.stdout)
      return { exitCode: result.exitCode, result: value === undefined ? null : value, stdout: value === undefined ? result.stdout.slice(0, STDOUT_KEPT) : null, stderr: result.stderr }
    },
  }
}
