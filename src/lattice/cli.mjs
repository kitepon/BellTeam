import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { LATTICE_PROJECT_ID, latticeError } from '../lattice-protocol.mjs'

const SEAT_COMMANDS = ['plan', 'todo', 'status', 'session-context', 'help', '--help', '--version']
const STDOUT_LIMIT = 1024 * 1024, STDERR_LIMIT = 4096

// Named protection: Lattice's host commands (setup, hooks, bridge, dashboard, run, sensor) would act as the server uid.
export function checkSeatArgs(args, input = null) {
  if (!SEAT_COMMANDS.includes(args[0])) throw Object.assign(latticeError('LATTICE_COMMAND_NOT_SEAT_SURFACE'), { detail: `allowed: ${SEAT_COMMANDS.join(', ')}` })
  if (input !== null && args.includes('--input')) throw latticeError('LATTICE_INPUT_CONFLICT')
}

export function createLatticeCli({ bin, chartsRoot = '/srv/bellteam/state/lattice', home = '/srv/bellteam/state/lattice-home',
  spawnImpl = spawn, timeoutMs = 60000 } = {}) {
  const dir = id => join(chartsRoot, id)
  // The package is bundled with the module, not installed in every tree, so it is resolved at first use.
  let resolved = bin
  const binPath = () => {
    try { return resolved ??= createRequire(import.meta.url).resolve('@quolu/lattice/bin/lattice.mjs') }
    catch { throw latticeError('LATTICE_UNAVAILABLE', 503) }
  }
  const isDir = path => stat(path).then(info => info.isDirectory(), () => false)

  const spawnRun = (args, cwd, env) => new Promise((resolve, reject) => {
    const out = [], err = []
    let outBytes = 0, errBytes = 0, done = false
    let child
    try { child = spawnImpl(process.execPath, [binPath(), ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }) } catch (error) { reject(error); return }
    const finish = (exitCode, stderr) => {
      if (done) return
      done = true; clearTimeout(timer)
      resolve({ exitCode, stdout: Buffer.concat(out).toString('utf8'), stderr: stderr ?? Buffer.concat(err).subarray(-STDERR_LIMIT).toString('utf8') })
    }
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(null, 'LATTICE_CLI_TIMEOUT') }, timeoutMs)
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
      const entries = await readdir(chartsRoot, { withFileTypes: true }).catch(() => [])
      // A chart exists once Lattice wrote its store; a dir made by a help-only call is not a chart.
      const ids = entries.filter(entry => entry.isDirectory() && LATTICE_PROJECT_ID.test(entry.name)).map(entry => entry.name)
      return (await Promise.all(ids.map(async id => await isDir(join(dir(id), '.lattice')) ? id : null))).filter(Boolean).sort()
    },
    exists: async id => LATTICE_PROJECT_ID.test(id) && await isDir(join(dir(id), '.lattice')),
    async ensure(id) {
      await mkdir(home, { recursive: true, mode: 0o700 })
      await mkdir(dir(id), { recursive: true, mode: 0o700 })
      if (await isDir(join(dir(id), '.git'))) return
      await promisify(execFile)('git', ['init', '-q'], { cwd: dir(id), env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } })
    },
    async run({ id, args, env = {}, input = null }) {
      checkSeatArgs(args, input)
      const full = { PATH: process.env.PATH, HOME: home, LATTICE_DASHBOARD_AUTOSTART: '0', GIT_CONFIG_NOSYSTEM: '1', ...env }
      if (input === null) return spawnRun(args, dir(id), full)
      const temp = await mkdtemp(join(tmpdir(), 'lattice-input-'))
      try {
        const file = join(temp, 'input.json')
        await writeFile(file, JSON.stringify(input), { mode: 0o600 })
        return await spawnRun([...args, '--input', file], dir(id), full)
      } finally { await rm(temp, { recursive: true, force: true }) }
    },
  }
}
