import { spawn } from 'node:child_process'
import { join } from 'node:path'

export function createHttpGatewayProcess({ socketPath, port, appRoot }) {
  let child = null, address = null, ending = null
  const start = async () => {
    if (child) throw new Error('GATEWAY_ALREADY_STARTED')
    const next = spawn(process.execPath, [join(appRoot, 'src/http-gateway-entry.mjs'), socketPath, String(port)], {
      env: {}, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
    child = next
    ending = new Promise(resolve => next.once('close', (code, signal) => {
      if (child === next) { child = null; address = null }
      resolve({ code, signal })
    }))
    try {
      await new Promise((resolve, reject) => {
        const earlyExit = () => reject(new Error('GATEWAY_START_FAILED'))
        const failed = error => reject(error)
        next.once('close', earlyExit)
        next.once('error', failed)
        next.once('message', message => {
          if (message?.type !== 'ready' || !Number.isInteger(message.address?.port)) return reject(new Error('GATEWAY_START_FAILED'))
          address = message.address
          next.removeListener('close', earlyExit)
          next.removeListener('error', failed)
          resolve()
        })
      })
      return address
    } catch (error) {
      next.kill('SIGTERM')
      await ending
      throw error
    }
  }
  let closing = null
  const close = () => {
    if (!child) return ending ?? Promise.resolve()
    if (!closing) {
      const next = child, ended = ending
      closing = (async () => {
        try {
          if (next.connected) await new Promise((resolve, reject) => next.send({ type: 'close' }, error => error ? reject(error) : resolve()))
          else next.kill('SIGTERM')
        } finally { await ended }
      })().finally(() => { closing = null })
    }
    return closing
  }
  return { start, close, get address() { return address }, get pid() { return child?.pid ?? null } }
}
