import { spawn } from 'node:child_process'
import { runtimeEnvironment } from './runtime-home.mjs'

export function runWaitProcess(waitProcess, signal = null) {
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
