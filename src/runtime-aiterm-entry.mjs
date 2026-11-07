// Fixed siblings satisfy Aiterm setup; each invocation resolves its launch's retained closure.
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { isAbsolute, join } from 'node:path'
import { createRequire } from 'node:module'
import { captureRuntime } from './runtime-selection.mjs'
import { RUNTIME_EXEC } from './aiterm-hooks.mjs'

const entries = ['index.js', 'execution-native-server.js', 'claude-parent-hook.js', 'cursor-parent-hook.js', 'codex-parent-hook.js', 'delivery-wake-cli.js']
const resolveDist = env => promisify(execFile)(process.execPath,
  [RUNTIME_EXEC, '--resolve', 'runtime-aiterm-mcp', 'dist'], { env, maxBuffer: 8192 })

export async function aitermEntrySpec(entry, args, { environment = process.env, capture = captureRuntime, resolve = resolveDist } = {}) {
  if (!entries.includes(entry)) throw new Error('RUNTIME_ENTRY_INVALID')
  const inherited = environment.BELLTEAM_RUNTIME_GENERATION
  const runtime = await capture({ generation: inherited === undefined ? undefined : inherited || null })
  const env = { ...environment, BELLTEAM_RUNTIME_GENERATION: runtime.generation ?? '' }
  const { stdout } = await resolve(env)
  const dist = stdout.replace(/\n$/u, '')
  if (!isAbsolute(dist) || /[\r\n\0]/u.test(dist) || dist !== runtime.components['runtime-aiterm-mcp'].dist)
    throw new Error('RUNTIME_BINDING_UNAVAILABLE')
  const forwarded = [...args]
  if (entry === 'execution-native-server.js') {
    const provider = forwarded.indexOf('--steer-provider')
    if (provider >= 0) forwarded[provider + 1] = createRequire(join(dist, entry)).resolve('aiterm-steer-delivery')
  }
  return { command: process.execPath, args: [join(dist, entry), ...forwarded], env }
}

export async function runAitermEntry(entry, { spec = aitermEntrySpec } = {}) {
  try {
    const { command, args, env } = await spec(entry, process.argv.slice(2))
    await new Promise(resolve => {
      const child = spawn(command, args, { env, stdio: 'inherit' })
      const forwards = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => {
        const forward = () => child.kill(signal)
        process.on(signal, forward)
        return [signal, forward]
      }))
      let failed = false
      child.once('error', () => { failed = true; process.stderr.write('RUNTIME_AITERM_ENTRY_FAILED\n') })
      child.once('close', (code, signal) => {
        for (const [name, forward] of forwards) process.removeListener(name, forward)
        if (failed) process.exitCode = 1
        else if (signal) process.kill(process.pid, signal)
        else process.exitCode = code ?? 1
        resolve()
      })
    })
  } catch {
    process.stderr.write('RUNTIME_AITERM_ENTRY_FAILED\n')
    process.exitCode = 1
  }
}
