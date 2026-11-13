import { execFile, spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { LATTICE_PROJECT_ID, latticeError, validLatticeName } from '../lattice-protocol.mjs'

const SEAT_COMMANDS = ['plan', 'todo', 'status', 'session-context', 'help', '--help', '--version']
// stderr keeps 64 KiB: Lattice's JSON refusals (lattice.cli_error.v2) list every problem and run past 4 KiB on a 20-task plan.
const STDOUT_LIMIT = 1024 * 1024, STDERR_LIMIT = 64 * 1024

// Named protection: Lattice's host commands (setup, hooks, bridge, dashboard, run, sensor) would act as the server uid.
export function checkSeatArgs(args, input = null) {
  if (!SEAT_COMMANDS.includes(args[0])) throw Object.assign(latticeError('LATTICE_COMMAND_NOT_SEAT_SURFACE'), { detail: `allowed: ${SEAT_COMMANDS.join(', ')}` })
  if (input !== null && args.includes('--input')) throw latticeError('LATTICE_INPUT_CONFLICT')
  if (input === null && args.includes(INPUT_TOKEN)) throw latticeError('LATTICE_INPUT_CONFLICT')
}
// `@input` in args marks where the input file goes (e.g. `todo structure realize --realized @input`); otherwise `--input <file>` is appended.
export const INPUT_TOKEN = '@input'

export function createLatticeCli({ bin, chartsRoot = '/srv/bellteam/state/lattice', home = '/srv/bellteam/state/lattice-home',
  spawnImpl = spawn, timeoutMs = 60000 } = {}) {
  const dir = id => join(chartsRoot, id)
  // The package is bundled with the module, not installed in every tree, so it is resolved at first use.
  let resolved = bin
  const binPath = () => {
    try { return resolved ??= createRequire(import.meta.url).resolve('@quolu/lattice/bin/lattice.mjs') }
    catch { throw latticeError('LATTICE_UNAVAILABLE', 503) }
  }
  // Only a missing path means "no chart"; any other I/O error is LATTICE_UNAVAILABLE and nothing is cached, so the next call recovers.
  // The charts root itself must be a directory: a file there (ENOTDIR) is unavailable, not "no charts".
  const failed = (error, missing = ['ENOENT', 'ENOTDIR']) => { if (missing.includes(error?.code)) return null; throw Object.assign(latticeError('LATTICE_UNAVAILABLE', 503), { detail: error?.code ?? 'EIO' }) }
  const isDir = path => stat(path).then(info => info.isDirectory(), error => failed(error) ?? false)
  const nameFile = id => join(dir(id), '.bellteam-chart.json')
  const recordFile = join(chartsRoot, '.bellteam-owner-decisions.json')
  // Named protection: a chart dir or sidecar that is a symlink would let the server uid write or run outside the charts root.
  // Self-exit: the call fails LATTICE_UNAVAILABLE (detail ELINK) and writes nothing; once the link is replaced by a real dir, the next call works.
  const linkError = () => Object.assign(latticeError('LATTICE_UNAVAILABLE', 503), { detail: 'ELINK' })
  const realDir = async id => {
    const info = await lstat(dir(id)).catch(error => failed(error))
    if (info && (info.isSymbolicLink() || !info.isDirectory())) throw linkError()
    return Boolean(info)
  }
  const readMeta = async id => {
    const link = await lstat(nameFile(id)).catch(error => failed(error))
    if (link?.isSymbolicLink()) return { name: null, createdBy: null }
    const text = await readFile(nameFile(id), 'utf8').catch(error => failed(error))
    let value = null
    try { value = text === null ? null : JSON.parse(text) } catch {}
    return { name: validLatticeName(value?.name) ? value.name : null, createdBy: typeof value?.createdBy === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value.createdBy) ? value.createdBy : null }
  }

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

  return {
    async list() {
      const entries = await readdir(chartsRoot, { withFileTypes: true }).catch(error => failed(error, ['ENOENT']) ?? [])
      // A chart exists once Lattice wrote its store; a dir made by a help-only call is not a chart.
      const ids = entries.filter(entry => entry.isDirectory() && LATTICE_PROJECT_ID.test(entry.name)).map(entry => entry.name)
      return (await Promise.all(ids.map(async id => await isDir(join(dir(id), '.lattice')) ? id : null))).filter(Boolean).sort()
    },
    exists: async id => LATTICE_PROJECT_ID.test(id) && await isDir(join(dir(id), '.lattice')),
    // Owner-lane filing record (README L18): one JSON object beside the charts. Missing = {}.
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
      const temp = `${recordFile}.${process.pid}.tmp`
      const file = await open(temp, 'wx', 0o600)
      try {
        try { await file.writeFile(JSON.stringify(value) + '\n') } finally { await file.close() }
        await rename(temp, recordFile)
      } catch (error) { await rm(temp, { force: true }); throw error }
    },
    // The chart's display name and creator, kept beside Lattice's store; Lattice has neither. A malformed field is absent.
    meta: readMeta,
    async setMeta(id, patch) {
      if (!await realDir(id)) throw linkError()
      const next = { ...await readMeta(id), ...patch }
      const temp = `${nameFile(id)}.${process.pid}.tmp`
      // wx: never follow or reuse an existing path; rename replaces a sidecar link itself, never its target.
      const file = await open(temp, 'wx', 0o600)
      // From here the temp is ours: on any failure remove it, so the next save in this process is not stuck on EEXIST.
      try {
        try { await file.writeFile(JSON.stringify(Object.fromEntries(Object.entries(next).filter(([, item]) => item !== null))) + '\n') } finally { await file.close() }
        await rename(temp, nameFile(id))
      } catch (error) { await rm(temp, { force: true }); throw error }
    },
    // Only for a dir this invocation created (ensure() said created) that still holds no Lattice store.
    async prune(id) {
      if (!LATTICE_PROJECT_ID.test(id) || !await realDir(id) || await isDir(join(dir(id), '.lattice'))) return
      await rm(dir(id), { recursive: true, force: true })
    },
    // Returns {created}: true only when this call made the chart dir (a plain mkdir, so an existing path is never claimed).
    async ensure(id) {
      await mkdir(home, { recursive: true, mode: 0o700 })
      await mkdir(chartsRoot, { recursive: true, mode: 0o700 })
      const created = await mkdir(dir(id), { mode: 0o700 }).then(() => true, error => { if (error.code === 'EEXIST') return false; throw error })
      if (!created) await realDir(id)
      if (!await isDir(join(dir(id), '.git'))) await promisify(execFile)('git', ['init', '-q'], { cwd: dir(id), env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } })
      return { created }
    },
    async run({ id, args, env = {}, input = null }) {
      checkSeatArgs(args, input)
      if (!await realDir(id)) throw Object.assign(latticeError('LATTICE_UNAVAILABLE', 503), { detail: 'ENOENT' })
      // LATTICE_CHARTS_ROOT (Lattice 0.99.0): a task may wait on a task of another chart under this root, read only (README L3).
      const full = { PATH: process.env.PATH, HOME: home, LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_CHARTS_ROOT: chartsRoot, GIT_CONFIG_NOSYSTEM: '1', ...env }
      if (input === null) return spawnRun(args, dir(id), full)
      const temp = await mkdtemp(join(tmpdir(), 'lattice-input-'))
      try {
        const file = join(temp, 'input.json')
        await writeFile(file, JSON.stringify(input), { mode: 0o600 })
        return await spawnRun(args.includes(INPUT_TOKEN) ? args.map(arg => arg === INPUT_TOKEN ? file : arg) : [...args, '--input', file], dir(id), full)
      } finally { await rm(temp, { recursive: true, force: true }) }
    },
    // Module operations on a code chart (code-chart.mjs): git and the bundled sensor. Never reachable from the seat surface.
    async git(id, args, timeoutMs = 60000) {
      if (!await realDir(id)) throw linkError()
      const { stdout } = await promisify(execFile)('git', args, { cwd: dir(id), timeout: timeoutMs, maxBuffer: STDOUT_LIMIT,
        env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } })
      return stdout.trim()
    },
    async sensor(id, command) {
      if (!['init', 'sync'].includes(command) || !await realDir(id)) throw linkError()
      return spawnRun(['sensor', command, '.', '--json'], dir(id), { PATH: process.env.PATH, HOME: home, LATTICE_DASHBOARD_AUTOSTART: '0', GIT_CONFIG_NOSYSTEM: '1' }, 120000)
    },
    exclude: async (id, lines) => {
      if (!await realDir(id)) throw linkError()
      const file = join(dir(id), '.git', 'info', 'exclude')
      const text = await readFile(file, 'utf8').catch(error => failed(error) ?? '')
      const missing = lines.filter(line => !text.split('\n').includes(line))
      if (!missing.length) return
      await mkdir(join(dir(id), '.git', 'info'), { recursive: true })
      await writeFile(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`, { mode: 0o600 })
    },
  }
}
