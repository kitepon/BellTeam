import { createServer } from 'node:net'
import { createHttpGateway } from './http-gateway.mjs'

// The fourth argument (earlier versions' asset roots) is no longer read: there is no browser UI to serve (a487).
const [socketPath, configuredPort, configuredVersion] = process.argv.slice(2)
const port = Number(configuredPort)
if (!socketPath?.startsWith('/') || !Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error('GATEWAY_CONFIGURATION_INVALID')
const assetVersion = configuredVersion || Date.now().toString(36)
const gateway = createHttpGateway({ socketPath, assetVersion })
await new Promise((resolve, reject) => {
  gateway.server.once('error', reject)
  // SO_REUSEPORT: the next gateway binds beside this one and is ready before this one stops (95eef79b).
  gateway.server.listen({ port, host: '0.0.0.0', reusePort: true }, resolve)
})
// The parent's ready read must reach this process, not whichever gateway the kernel picks on the shared port.
// One connection, injected into the same server, then the loopback port closes.
const probe = createServer(socket => { probe.close(); gateway.server.emit('connection', socket) })
await new Promise((resolve, reject) => {
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', resolve)
})
process.send?.({ type: 'ready', protocolVersion: 1, assetVersion, address: gateway.server.address(), probePort: probe.address().port })
let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  if (probe.listening) probe.close()
  try { await gateway.close() }
  catch { process.exitCode = 1 }
  finally { if (process.connected) process.disconnect() }
}
process.on('message', message => { if (message?.type === 'close') void stop() })
// The parent still offers the new version's asset root during an exchange (the exchange protocol is unchanged); there is nothing to serve from it, so check the shape and acknowledge.
process.on('message', message => { if (message?.type === 'asset-version') acknowledgeAssetVersion(message) })
function acknowledgeAssetVersion({ version, root }) {
  const invalid = typeof version !== 'string' || !version || version === assetVersion || typeof root !== 'string' || !root.startsWith('/')
  if (process.connected) process.send({ type: 'asset-version-ack', version, ...(invalid ? { error: 'GATEWAY_ASSET_VERSION_INVALID' } : {}) })
}
process.on('disconnect', () => { void stop() })
process.on('SIGTERM', () => { void stop() })
process.on('SIGINT', () => { void stop() })
