// Only invoked through the fixed seat entry with the base environment.
// The seat owns setup.log; no evaluated environment or log body returns to the server.
import { spawn } from 'node:child_process'
import { access, mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { requireSeatProject } from './seat-command.mjs'

let active, stopping = false, timer
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => {
  stopping = true
  if (!active) return
  active.kill(signal)
  // Reap the immediate setup child before the outer group's 250ms fallback.
  // The outer wrapper still owns escalation for other group descendants.
  if (!timer) timer = setTimeout(() => active?.kill('SIGKILL'), 150)
})

try {
  const [project, ...extra] = process.argv.slice(2)
  requireSeatProject(project)
  if (extra.length || process.getuid() !== 1000 || process.geteuid() !== 1000
    || process.getgid() !== 1000) throw Error('IDENTITY_OR_ARGUMENTS')
  const directory = join(project, 'environment')
  await mkdir(directory, { recursive: true })
  const script = join(directory, 'setup.sh')
  let present = true
  try { await access(script) } catch (error) { if (error.code === 'ENOENT') present = false; else throw error }
  if (!present) process.stdout.write(JSON.stringify({ present: false }))
  else {
    const log = await open(join(directory, 'setup.log'), 'w', 0o600)
    let code = null
    try {
      await log.write(`[${new Date().toISOString()}] ${script}\n`)
      if (stopping) throw Error('STOPPED')
      code = await new Promise((resolve, reject) => {
        // Keep the same process group so the outer wrapper cancels setup and
        // its descendants, including a TERM-ignoring child.
        const child = spawn('bash', ['--noprofile', '--norc', '-e', script], {
          cwd: project, env: process.env, stdio: ['ignore', log.fd, log.fd],
        })
        active = child
        child.once('error', reject)
        child.once('close', value => { clearTimeout(timer); active = null; resolve(value) })
      })
    } catch {
      await log.write('\nBELLTEAM_SEAT_SETUP_FAILED\n')
    } finally {
      await log.write(`\n終了コード: ${code}\n`)
      await log.close()
    }
    process.stdout.write(JSON.stringify({ present: true, code }))
  }
} catch {
  process.stderr.write('BELLTEAM_SEAT_SETUP_FAILED\n')
  process.exitCode = 1
}
