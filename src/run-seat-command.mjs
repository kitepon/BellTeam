// Runs only after seat-exec has dropped all identity slots to the seat UID.
import { spawn } from 'node:child_process'
import { readSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { baseBotEnvironment, loadBotEnvironment } from './bot-environment.mjs'
import { RESUME_STATE_BASE } from './resume-policy.mjs'
import { validateSecretEnv } from './seat-command.mjs'

// O2: exactly one line from fd 0, byte by byte, so nothing after the newline is consumed (the command inherits the rest as its stdin).
function readEnvLine(limit = 128 * 1024) {
  const bytes = [], one = Buffer.alloc(1)
  for (;;) {
    let n
    try { n = readSync(0, one, 0, 1, null) } catch (error) {
      if (error.code === 'EAGAIN') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); continue }
      throw error
    }
    if (n === 0) throw Error('ENV_LINE_EOF')
    if (one[0] === 10) return Buffer.from(bytes).toString('utf8')
    if (bytes.length >= limit) throw Error('ENV_LINE_TOO_LONG')
    bytes.push(one[0])
  }
}

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
  const [project, ...parameters] = process.argv.slice(2)
  const baseOnly = parameters[0] === '--base-environment'
  if (baseOnly) parameters.shift()
  const resume = parameters[0] === '--resume-state-base'
  if (resume) parameters.shift()
  const envStdin = parameters[0] === '--env-stdin'
  if (envStdin) parameters.shift()
  const [separator, command, ...args] = parameters
  if (process.getuid() !== 1000 || process.geteuid() !== 1000 || process.getgid() !== 1000
    || !isAbsolute(project ?? '') || separator !== '--' || !command) throw Error('IDENTITY_OR_ARGUMENTS')
  // setup must run before env.sh is usable. Both modes stay in the seat UID.
  const inherited = { ...process.env, ...(resume ? { AITERM_STATE_BASE: RESUME_STATE_BASE } : {}) }
  const env = baseOnly ? baseBotEnvironment(project, inherited) : await loadBotEnvironment(project, inherited, {
    run: (command, args, options) => run(command, args, options, true),
  })
  if (stopping) throw Error('STOPPED')
  // The line is read and validated before the command starts; a bad line starts nothing. Names the base environment already sets are refused.
  const secret = envStdin ? validateSecretEnv(JSON.parse(readEnvLine()), env) : null
  if (secret) Object.assign(env, secret)
  // execution.md "Body-side Aiterm keeps the kernel default": the parent's own Aiterm marks its launch with this env
  // assignment (an older wrapper just passes it on); seat-exec set 1000 and a seat UID may lower it. Best effort.
  let marked = 0
  if (command === '/usr/bin/env') while (/^\w+=/.test(args[marked] ?? '')) marked++
  if (args.slice(0, marked).includes('BELLTEAM_OOM_BIAS=0')) try { writeFileSync('/proc/self/oom_score_adj', '0\n') } catch {}
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
