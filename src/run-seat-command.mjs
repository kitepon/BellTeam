// Runs only after seat-exec has dropped all identity slots to the seat UID.
import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { loadBotEnvironment } from './bot-environment.mjs'

let active, stopping = false, stopSignal
function signalGroup(signal) {
  if (!active?.pid) return
  try { process.kill(-active.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => {
  stopping = true; stopSignal = signal
  try { signalGroup(signal) } catch { /* fixed failure below; no process details */ }
})

async function run(command, args, options, capture = false) {
  if (stopping) throw Error('STOPPED')
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, detached: true,
      stdio: capture ? ['ignore', 'pipe', 'ignore'] : 'inherit' })
    active = child
    const output = []
    if (capture) child.stdout.on('data', chunk => output.push(chunk))
    child.once('error', reject)
    child.once('close', async (code, signal) => {
      if (stopping) {
        // Keep the group identity until escalation; do not exit on the sudo/
        // shell monitor alone while its synthetic/real descendants can remain.
        await delay(250)
        try { signalGroup('SIGKILL') } catch {}
      }
      active = null
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
