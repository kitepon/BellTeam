import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LATTICE_PROJECT_ID, latticeError, validLatticeName } from '../lattice-protocol.mjs'

const SEAT_COMMANDS = ['plan', 'todo', 'status', 'session-context', 'help', '--help', '--version']
// stderr keeps 64 KiB: Lattice's JSON refusals (lattice.cli_error.v2) list every problem and run past 4 KiB on a 20-task plan.
// 16 MiB: bellteam's display read is 0.84 MB (2026-11-14); a larger output reads as LATTICE_CLI_BAD_JSON (README).
const STDOUT_LIMIT = 16 * 1024 * 1024, STDERR_LIMIT = 64 * 1024

// Named protection: Lattice's host commands (setup, hooks, bridge, dashboard, run, sensor, charts, chart) would act as the server uid.
// The module calls its own host commands (K1, K2, K4, K7) through `host`, never through a seat's args.
export function checkSeatArgs(args, input = null) {
  if (!SEAT_COMMANDS.includes(args[0])) throw Object.assign(latticeError('LATTICE_COMMAND_NOT_SEAT_SURFACE'), { detail: `allowed: ${SEAT_COMMANDS.join(', ')}` })
  if (input !== null && args.includes('--input')) throw latticeError('LATTICE_INPUT_CONFLICT')
  if (input === null && args.includes(INPUT_TOKEN)) throw latticeError('LATTICE_INPUT_CONFLICT')
}
// `@input` in args marks where the input file goes (e.g. `todo structure realize --realized @input`); otherwise `--input <file>` is appended.
export const INPUT_TOKEN = '@input'

export function createLatticeCli({ bin, chartsRoot = '/srv/bellteam/state/lattice', home = '/srv/bellteam/state/lattice-home',
  stateDir = '/srv/bellteam/state/lattice-module', spawnImpl = spawn, timeoutMs = 60000 } = {}) {
  // The package is bundled with the module, not installed in every tree, so it is resolved at first use.
  let resolved = bin
  const binPath = () => {
    try { return resolved ??= createRequire(import.meta.url).resolve('@quolu/lattice/bin/lattice.mjs') }
    catch { throw latticeError('LATTICE_UNAVAILABLE', 503) }
  }
  // BellTeam's own record (README L18), in BellTeam's own state dir, never inside Lattice's charts root (a102).
  const recordFile = join(stateDir, 'owner-decisions.json')
  // Only a missing path means "nothing yet"; any other I/O error is LATTICE_UNAVAILABLE and nothing is cached.
  const failed = (error, missing = ['ENOENT', 'ENOTDIR']) => { if (missing.includes(error?.code)) return null; throw Object.assign(latticeError('LATTICE_UNAVAILABLE', 503), { detail: error?.code ?? 'EIO' }) }

  const spawnRun = (args, cwd, env, limitMs = timeoutMs) => new Promise((resolve, reject) => {
    const out = [], err = []
    let outBytes = 0, errBytes = 0, done = false
    let child
    try { child = spawnImpl(process.execPath, [binPath(), ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }) } catch (error) { reject(error); return }
    const finish = (exitCode, stderr) => {
      if (done) return
      done = true; clearTimeout(timer)
      resolve({ exitCode, stdout: Buffer.concat(out).toString('utf8'), stderr: stderr ?? Buffer.concat(err).subarray(-STDERR_LIMIT).toString('utf8') })
    }
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(null, 'LATTICE_CLI_TIMEOUT') }, limitMs)
    child.stdout.on('data', chunk => { if (outBytes < STDOUT_LIMIT) out.push(chunk.subarray(0, STDOUT_LIMIT - outBytes)); outBytes += chunk.length })
    child.stderr.on('data', chunk => {
      err.push(chunk); errBytes += chunk.length
      while (errBytes - err[0].length >= STDERR_LIMIT) errBytes -= err.shift().length
    })
    child.on('error', () => finish(null, 'LATTICE_CLI_SPAWN_FAILED'))
    child.on('close', code => finish(code ?? null))
  })

  // Every call addresses the chart by id (K8): Lattice resolves it under LATTICE_CHARTS_ROOT; BellTeam never builds the chart path.
  const envOf = (id, env) => ({ PATH: process.env.PATH, HOME: home, LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_CHARTS_ROOT: chartsRoot, GIT_CONFIG_NOSYSTEM: '1',
    ...(id ? { LATTICE_PROJECT_ID: id } : {}), ...env })
  async function host(id, args, env = {}, limitMs) {
    await mkdir(home, { recursive: true, mode: 0o700 })
    const result = await spawnRun(args, home, envOf(id, env), limitMs)
    let value
    try { value = JSON.parse(result.stdout) } catch {}
    if (result.exitCode !== 0 || value === undefined) throw Object.assign(latticeError('LATTICE_UNAVAILABLE', 503), { detail: result.exitCode === null ? result.stderr.trim().slice(0, 64) : `EXIT_${result.exitCode}` })
    return value
  }
  // K2: change tokens of the given charts in one process; null = no chart.
  async function sources(list) {
    const wanted = list.filter(id => LATTICE_PROJECT_ID.test(id))
    if (!wanted.length) return new Map()
    const value = await host(null, ['charts', 'source', ...wanted.flatMap(id => ['--project', id]), '--json'])
    return new Map(wanted.map(id => [id, value.charts?.[id] ?? null]))
  }

  return {
    // K1: every chart under the root in one process: [{id, name, createdBy, source}] (README K1).
    async list() {
      const value = await host(null, ['charts', 'list', '--json'])
      return (value.charts ?? []).filter(chart => LATTICE_PROJECT_ID.test(chart?.project_id ?? '')).map(chart => ({ id: chart.project_id,
        name: validLatticeName(chart.name) ? chart.name : null, createdBy: typeof chart.created_by === 'string' ? chart.created_by : null, source: chart.source ?? null }))
    },
    sources,
    exists: async id => LATTICE_PROJECT_ID.test(id) && (await sources([id])).get(id) !== null,
    // K4: the chart's display name; the creator is Lattice's (the seat whose run created the store).
    async setName(id, name, from) { return host(id, ['chart', 'set', '--name', name, '--json'], { LATTICE_SEAT_ID: from }) },
    // K7: a code chart bound to its repo, kept current on request (fast-forward only; Lattice's own git and sensor).
    repoBind: (id, url, branch) => host(id, ['chart', 'repo', 'bind', '--url', url, '--branch', branch, '--json']),
    repoSync: id => host(id, ['chart', 'repo', 'sync', '--json'], {}, 120000),
    // Owner-lane filing record (README L18): one JSON object. Missing = {}.
    // A symlink or malformed file is moved aside (`.invalid-<ms>`) and starts empty; the body adopts a request already filed for the task by its session_label (L18), so nothing is filed twice.
    async readOwnerRecord() {
      const link = await lstat(recordFile).catch(error => failed(error))
      let value = null
      if (link && !link.isSymbolicLink()) try { value = JSON.parse(await readFile(recordFile, 'utf8')) } catch {}
      if (!link) return {}
      if (value && typeof value === 'object' && !Array.isArray(value)) return value
      await rename(recordFile, `${recordFile}.invalid-${Date.now()}`)
      return {}
    },
    async writeOwnerRecord(value) {
      await mkdir(stateDir, { recursive: true, mode: 0o700 })
      const temp = `${recordFile}.${process.pid}.tmp`
      const file = await open(temp, 'wx', 0o600)
      try {
        try { await file.writeFile(JSON.stringify(value) + '\n') } finally { await file.close() }
        await rename(temp, recordFile)
      } catch (error) { await rm(temp, { force: true }); throw error }
    },
    // shortcut: one-time move of what BellTeam kept inside Lattice's charts root before a102 (names, creators, the filing record); remove after the release that ran it everywhere.
    async migrateLegacy(rows) {
      const moved = { names: 0, record: false }
      for (const row of rows) {
        const sidecar = join(chartsRoot, row.id, '.bellteam-chart.json')
        const link = await lstat(sidecar).catch(() => null)
        if (!link || link.isSymbolicLink()) continue
        let value = null
        try { value = JSON.parse(await readFile(sidecar, 'utf8')) } catch {}
        const name = validLatticeName(value?.name) && value.name !== row.name ? value.name : null
        const createdBy = typeof value?.createdBy === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value.createdBy) && !row.createdBy ? value.createdBy : null
        // Name and creator move independently: an unnamed chart keeps its creator without a made-up name (K4 --created-by alone).
        if (name || createdBy) {
          await host(row.id, ['chart', 'set', ...(name ? ['--name', name] : []), ...(createdBy ? ['--created-by', createdBy] : []), '--json'], { LATTICE_SEAT_ID: createdBy ?? 'scheduler' })
          moved.names++
        }
        await rm(sidecar, { force: true })
      }
      const old = join(chartsRoot, '.bellteam-owner-decisions.json')
      if (await lstat(old).catch(() => null) && !await lstat(recordFile).catch(() => null)) {
        await mkdir(stateDir, { recursive: true, mode: 0o700 })
        await rename(old, recordFile); moved.record = true
      }
      return moved
    },
    async run({ id, args, env = {}, input = null }) {
      checkSeatArgs(args, input)
      if (!LATTICE_PROJECT_ID.test(id)) throw latticeError('LATTICE_PROJECT_INVALID')
      await mkdir(home, { recursive: true, mode: 0o700 })
      if (input === null) return spawnRun(args, home, envOf(id, env))
      const temp = await mkdtemp(join(tmpdir(), 'lattice-input-'))
      try {
        const file = join(temp, 'input.json')
        await writeFile(file, JSON.stringify(input), { mode: 0o600 })
        return await spawnRun(args.includes(INPUT_TOKEN) ? args.map(arg => arg === INPUT_TOKEN ? file : arg) : [...args, '--input', file], home, envOf(id, env))
      } finally { await rm(temp, { recursive: true, force: true }) }
    },
  }
}
