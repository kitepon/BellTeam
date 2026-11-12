// Code charts: a chart dir that is also a checkout of its product repo, so Lattice's conflict check and code graph
// read real source (docs/architecture/modules/lattice/README.md, Code charts, L8/L9). Child only; no I/O of its own.
export const CODE_CHARTS = Object.freeze({ bellteam: Object.freeze({ url: 'https://github.com/kitepon/BellTeam.git', branch: 'main' }) })
export const CODE_CHART_EXCLUDE = Object.freeze(['.lattice/', '.bellteam-chart.json', '.bellteam-chart.json.*.tmp'])
const DUE_MS = 120000

// Named protection: fetch and fast-forward only; never reset, clean, force or repoint origin (the store and others' state stay).
// Self-exit: any failed step logs one line and the next run 120 s later tries again.
// Lattice 0.86.1 prints its typed cli_error JSON on stderr (one line); stdout is checked too in case that moves.
const notInitialized = ({ stdout, stderr }) => `${stdout}\n${stderr}`.split('\n').some(line => {
  try { return JSON.parse(line).code === 'LATTICE_SENSOR_NOT_INITIALIZED' } catch { return false }
})

export function createCodeCharts({ cli, charts = CODE_CHARTS, now = () => Date.now(), log = () => {}, dueMs = DUE_MS }) {
  const last = new Map(), indexed = new Map() // indexed: id -> HEAD of this child's last successful sensor run
  async function step(id) {
    const { url, branch } = charts[id]
    await cli.exclude(id, CODE_CHART_EXCLUDE)
    const origin = await cli.git(id, ['remote', 'get-url', 'origin']).catch(() => null)
    if (origin === null) await cli.git(id, ['remote', 'add', 'origin', url])
    else if (origin !== url) return 'origin-elsewhere'
    // Someone's tracked edits: touch nothing (no fetch, merge or index of half-edited source).
    if (await cli.git(id, ['status', '--porcelain', '--untracked-files=no'])) return 'dirty'
    await cli.git(id, ['fetch', '--quiet', '--filter=blob:none', '--no-tags', 'origin', branch])
    const target = await cli.git(id, ['rev-parse', 'FETCH_HEAD'])
    const head = await cli.git(id, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => null)
    // Unborn branch (a chart made before it was a code chart): .lattice/ and the sidecar are excluded, so checkout leaves them.
    if (head === null) await cli.git(id, ['checkout', '--quiet', '-B', branch, target])
    else if (head !== target) await cli.git(id, ['merge', '--quiet', '--ff-only', target])
    else if (indexed.get(id) === head) return 'current'
    indexed.delete(id)
    let sensor = await cli.sensor(id, 'sync')
    // Lattice's typed answer, not a directory check: an interrupted init leaves .lattice/sensor without an index.
    if (sensor.exitCode !== 0 && notInitialized(sensor)) sensor = await cli.sensor(id, 'init')
    if (sensor.exitCode !== 0) return 'sensor-failed'
    indexed.set(id, target)
    return 'synced'
  }
  return {
    isCode: id => Object.hasOwn(charts, id),
    // Before a seat run on a code chart; at most once per dueMs. Never throws: the seat command runs on the checkout as it is.
    async maintain(id) {
      if (!Object.hasOwn(charts, id) || now() - (last.get(id) ?? -Infinity) < dueMs) return null
      last.set(id, now())
      try {
        const status = await step(id)
        if (!['current', 'synced'].includes(status)) log(`lattice-code ${id} ${status}`)
        return status
      } catch (error) { log(`lattice-code ${id} ${error.code ?? error.signal ?? 'LATTICE_CODE_FAILED'}`); return 'failed' }
    },
  }
}
