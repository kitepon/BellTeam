// Runs only after seat-exec has dropped all identity slots to the seat UID.
import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { loadBotEnvironment } from './bot-environment.mjs'

let active, stopping = false, stopSignal
function signalGroup(signal, child) {
  if (!child?.pid) return
  try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
}
function groupExists(child) {
  if (!child?.pid) return false
  try { process.kill(-child.pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => {
  stopping = true; stopSignal = signal
  const running = active
  // Start on receipt, not close: a TERM-ignoring process or inherited stdout
  // pipe can otherwise prevent close forever. Bind escalation to this child.
  if (running && !running.stop) {
    running.stop = new Promise(resolve => { running.resolveStop = resolve })
    running.timer = setTimeout(() => {
      try { signalGroup('SIGKILL', running.child) } catch {}
      running.resolveStop()
    }, 250)
  }
  try { signalGroup(signal, running?.child) } catch { /* no process details */ }
})

async function run(command, args, options, capture = false) {
  if (stopping) throw Error('STOPPED')
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, detached: true,
      stdio: capture ? ['ignore', 'pipe', 'ignore'] : 'inherit' })
    const running = { child, timer: null }
    active = running
    const output = []
    if (capture) child.stdout.on('data', chunk => output.push(chunk))
    child.once('error', reject)
    child.once('close', async (code, signal) => {
      // A leader can exit while its group remains alive without holding stdio.
      // Cancel escalation only when the group is already absent; otherwise
      // wait for the signal-time escalation before this wrapper exits.
      if (running.stop) {
        if (!groupExists(child)) { clearTimeout(running.timer); running.resolveStop() }
        await running.stop
      }
      if (active === running) active = null
      if (capture && (code !== 0 || signal || stopping)) reject(Error('ENVIRONMENT_FAILED'))
      else resolve({ stdout: Buffer.concat(output).toString(), code, signal })
    })
  })
}

try {
  const [project, separator, command, ...args] = process.argv.slice(2)
  if (process.getuid() !== 1000 || process.geteuid() !== 1000 || process.getgid() !== 1000
    || !isAbsolute(project ?? '') || separator !== '--' || !command) throw Error('IDENTITY_OR_ARGUMENTS')
  const env = await loadBotEnvironment(project, process.env, {
    run: (command, args, options) => run(command, args, options, true),
  })
  if (stopping) throw Error('STOPPED')
  const result = await run(command, args, { cwd: project, env })
  process.exitCode = result.code ?? 1
  if (result.signal) stopSignal = result.signal
} catch {
  process.stderr.write('BELLTEAM_SEAT_COMMAND_FAILED\n')
  process.exitCode = 1
}
if (stopSignal) {
  process.removeAllListeners(stopSignal)
  process.kill(process.pid, stopSignal)
}
