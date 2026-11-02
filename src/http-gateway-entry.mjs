import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHttpGateway } from './http-gateway.mjs'

const [socketPath, configuredPort, configuredVersion, previousVersions = '[]'] = process.argv.slice(2)
const port = Number(configuredPort)
if (!socketPath?.startsWith('/') || !Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error('GATEWAY_CONFIGURATION_INVALID')
const assetVersion = configuredVersion || Date.now().toString(36)
const assetVersions = new Map()
for (const [version, root] of JSON.parse(previousVersions)) {
  const assets = await import(pathToFileURL(join(root, 'web/assets.mjs')).href)
  assetVersions.set(version, { root: join(root, 'web'), files: assets.webAssetFiles, versioned: assets.versionedWebAssets })
}
const gateway = createHttpGateway({ socketPath, assetVersion, assetVersions,
  staticRoot: join(dirname(dirname(fileURLToPath(import.meta.url))), 'web') })
await new Promise((resolve, reject) => {
  gateway.server.once('error', reject)
  gateway.server.listen(port, '0.0.0.0', resolve)
})
process.send?.({ type: 'ready', protocolVersion: 1, assetVersion, address: gateway.server.address() })
let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  try { await gateway.close() }
  catch { process.exitCode = 1 }
  finally { if (process.connected) process.disconnect() }
}
process.on('message', message => { if (message?.type === 'close') void stop() })
process.on('disconnect', () => { void stop() })
process.on('SIGTERM', () => { void stop() })
process.on('SIGINT', () => { void stop() })
