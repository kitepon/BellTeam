import { spawn } from 'node:child_process'
import { runtimeEnvironment } from './runtime-home.mjs'
import { createSeatProcessRunner } from './seat-process.mjs'

export function runWaitProcess(waitProcess, signal = null, options = {}) {
  const seatProject = Object.hasOwn(options, 'seatProject') ? options.seatProject : null
  if (seatProject !== null) return createSeatProcessRunner(seatProject)(waitProcess.executable, waitProcess.args, { signal }).then(({ stdout }) => {
    try { return JSON.parse(stdout.trim()) } catch { throw new Error('AITERM_WAIT_INVALID') }
  })
  return new Promise((resolve, reject) => {
    const child = spawn(waitProcess.executable, waitProcess.args, {
      env: runtimeEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], ...(signal ? { signal } : {}),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', () => {
      try {
        resolve(JSON.parse(stdout.trim()))
      } catch {
        reject(new Error(`AITERM_WAIT_INVALID: ${stderr.trim()}`))
      }
    })
  })
}
