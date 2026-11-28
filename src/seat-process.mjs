// execFile-compatible reader for seat commands. The privileged entry and seat
// wrapper own identity/environment and group cancellation, not this caller.
import { spawn } from 'node:child_process'
import { seatCommandSpec, validateSecretEnv } from './seat-command.mjs'
import { runtimeHome } from './runtime-home.mjs'

const failure = (code, properties = {}) => Object.assign(new Error(code), { code, ...properties })

export function createSeatProcessRunner(project, { environment = 'configured' } = {}) {
  // Validate before a caller can supply input or start a process.
  seatCommandSpec('true', [], { project, environment })
  return (command, args = [], options = {}) => {
    if (Object.hasOwn(options, 'env')) throw failure('SEAT_DYNAMIC_ENV_UNWIRED')
    const { signal, input, maxBuffer = 16 * 1024 * 1024, acceptNonzero = false, secretEnv } = options
    // O2: the only way an environment enters. Validated before a process starts; the value goes on the stdin line, never into argv or a file.
    if (secretEnv !== undefined) validateSecretEnv(secretEnv)
    if (typeof acceptNonzero !== 'boolean') throw failure('SEAT_EXIT_MODE_INVALID')
    const spec = seatCommandSpec(command, args, { project, environment, secretEnv: secretEnv !== undefined })
    if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 1) throw failure('SEAT_BUFFER_INVALID')
    if (input !== undefined && typeof input !== 'string' && !Buffer.isBuffer(input)) throw failure('SEAT_INPUT_INVALID')
    if (signal?.aborted) return Promise.reject(failure('ABORT_ERR', { name: 'AbortError', effect: 'not_started' }))
    return new Promise((resolve, reject) => {
      const child = spawn(spec.command, spec.args, { env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] })
      const stdout = [], stderr = []
      let size = 0, stopped = null, spawnError = null, inputError = null
      const stop = error => {
        if (stopped) return
        stopped = error
        // sudo forwards this to the fixed wrapper, which starts escalation at
        // signal receipt. Do not report cancellation before its stdio closes.
        child.kill('SIGTERM')
      }
      const abort = () => stop(failure('ABORT_ERR', { name: 'AbortError' }))
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      const capture = list => chunk => {
        size += chunk.length
        if (size > maxBuffer) stop(failure('SEAT_BUFFER_EXCEEDED'))
        else if (!stopped) list.push(chunk)
      }
      child.stdout.on('data', capture(stdout))
      child.stderr.on('data', capture(stderr))
      child.once('error', error => { spawnError = failure('SEAT_PROCESS_START_FAILED', { cause: error }) })
      child.stdin.on('error', () => { inputError = failure('SEAT_INPUT_FAILED') })
      child.once('close', (exitCode, exitSignal) => {
        signal?.removeEventListener('abort', abort)
        if (spawnError || stopped) return reject(spawnError ?? stopped)
        if (inputError) return reject(inputError)
        if (!acceptNonzero && (exitCode !== 0 || exitSignal)) return reject(failure('SEAT_PROCESS_FAILED', { exitCode, signal: exitSignal }))
        resolve({ stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(),
          ...(acceptNonzero ? { code: exitCode, signal: exitSignal } : {}) })
      })
      // Fixed-stdin consumers require EOF; no input means an empty stream.
      if (secretEnv !== undefined) child.stdin.write(JSON.stringify(secretEnv) + '\n')
      child.stdin.end(input)
    })
  }
}

// The user place (a451, runtime/user-cli-place.md): AI CLIs the user installs live in the container user's /home/bell/.local, one copy
// for every seat. The privileged entry does not look at `project`, and base mode builds the environment from it, so project = HOME
// yields the place itself: PATH first /home/bell/.local/bin, npm prefix /home/bell/.local. Same sudo rule, limits and cancel as a seat.
export const userPlace = (environment = process.env) => `${runtimeHome(environment)}/.local`
export const createUserPlaceRunner = (environment = process.env) => createSeatProcessRunner(runtimeHome(environment), { environment: 'base' })
