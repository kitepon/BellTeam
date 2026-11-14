// Code charts: a chart bound to its product repo, so Lattice's conflict check and code graph read real source
// (docs/architecture/modules/lattice/README.md, Code charts, K7). The repo checkout, its git and the sensor are Lattice's (a102).
export const CODE_CHARTS = Object.freeze({ bellteam: Object.freeze({ url: 'https://github.com/kitepon/BellTeam.git', branch: 'main' }) })
const DUE_MS = 120000

// Lattice fast-forwards only from the last accepted tip, never resets or forces (K7). Self-exit: a failed sync logs one line
// and the next seat run 120 s later asks again.
export function createCodeCharts({ cli, charts = CODE_CHARTS, now = () => Date.now(), log = () => {}, dueMs = DUE_MS }) {
  const last = new Map(), bound = new Set()
  return {
    isCode: id => Object.hasOwn(charts, id),
    // Before a seat run on a code chart; at most once per dueMs. Never throws: the seat command runs on the checkout as it is.
    async maintain(id) {
      if (!Object.hasOwn(charts, id) || now() - (last.get(id) ?? -Infinity) < dueMs) return null
      last.set(id, now())
      try {
        if (!bound.has(id)) { await cli.repoBind(id, charts[id].url, charts[id].branch); bound.add(id) }
        const result = await cli.repoSync(id)
        const status = typeof result?.status === 'string' ? result.status : 'failed'
        if (!['current', 'synced'].includes(status)) log(`lattice-code ${id} ${status}${result?.failure?.step ? ` ${result.failure.step}` : ''}`)
        return status
      } catch (error) { log(`lattice-code ${id} ${error.code ?? 'LATTICE_CODE_FAILED'}`); return 'failed' }
    },
  }
}
