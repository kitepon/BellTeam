// An unsigned archive ABI probe; this never authenticates or installs a release.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const root = resolve(process.argv[2])
const require = createRequire(pathToFileURL(join(root, 'package.json')))
assert.ok(require.resolve('@modelcontextprotocol/sdk/client/index.js').startsWith(join(root, 'node_modules/')))
const temporary = await mkdtemp(join(tmpdir(), 'gateway-artifact-'))
const socket = join(temporary, 'public.sock')
const backend = createServer((request, response) => {
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(request.url === '/api/session' ? { authenticated: true } : { status: 'ok' }))
})
let child
try {
  backend.listen(socket); await once(backend, 'listening')
  const versionId = 'a'.repeat(64), previousVersionId = 'b'.repeat(64)
  child = spawn(process.execPath, [join(root, 'src/http-gateway-entry.mjs'), socket, '0', versionId,
    JSON.stringify([[previousVersionId, root]])], { env: {}, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('GATEWAY_ARTIFACT_START_TIMEOUT')), 10000)
    child.once('message', message => { clearTimeout(timer); resolve(message) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', () => { clearTimeout(timer); reject(Error('GATEWAY_ARTIFACT_START_FAILED')) })
  })
  assert.equal(ready.type, 'ready')
  assert.equal(ready.protocolVersion, 1)
  assert.equal(ready.assetVersion, versionId)
  const base = `http://127.0.0.1:${ready.address.port}`
  assert.deepEqual(await (await fetch(base + '/healthz')).json(), { status: 'ok' })
  assert.match(await (await fetch(base + '/')).text(), /<html/u)
  const previous = await fetch(base + '/?v=' + previousVersionId)
  assert.equal(previous.status, 200)
  assert.ok((await previous.text()).includes(previousVersionId))
  console.log(JSON.stringify({ protocolVersion: 1, fixedAssetVersionReady: true, previousAssetCatalog: true,
    packagedHealthAndHtml: true, sdkInsidePayload: true, authenticated: false }))
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const ended = once(child, 'close')
    child.kill('SIGKILL'); await ended
  }
  await new Promise(resolve => backend.close(resolve))
  await rm(temporary, { recursive: true, force: true })
}
