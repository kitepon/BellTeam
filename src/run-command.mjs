// Short-lived child of the scheduler, sharing its process group with env.sh and sh.
import { spawn } from 'node:child_process'
import { loadBotEnvironment } from './bot-environment.mjs'

let stopping = false
process.on('SIGTERM', () => { stopping = true })
process.on('SIGINT', () => { stopping = true })
try {
  const env = await loadBotEnvironment(process.cwd())
  if (stopping) process.exitCode = 1
  else {
    const child = spawn('sh', ['-c', process.argv[2]], { env, stdio: 'inherit' })
    child.once('error', () => { process.stderr.write('COMMAND_START_FAILED\n'); process.exitCode = 1 })
    child.once('close', (code, signal) => {
      if (signal) {
        process.removeAllListeners(signal)
        process.kill(process.pid, signal)
      } else process.exitCode = code ?? 1
    })
  }
} catch {
  process.stderr.write('COMMAND_ENVIRONMENT_FAILED\n')
  process.exitCode = 1
}
