import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareGatewayRelease, validateGatewayReleaseManifest } from '../src/web-gateway-release.mjs'

// Unsigned shape fixtures are never passed off as authenticated/root-installed releases.
const fixture = () => ({ schema: 'bellteam.web-gateway.artifact.v1', component: 'web-gateway',
  sourceCommit: 'a'.repeat(40), entry: 'payload/src/http-gateway-entry.mjs',
  runtime: { os: process.platform, arch: ({ x64: 'amd64', arm64: 'arm64' })[process.arch], nodeMajor: 26, parentProtocol: 1 },
  files: ['payload/src/http-gateway-entry.mjs', 'payload/package.json', 'payload/package-lock.json', 'payload/web/assets.mjs']
    .map(path => ({ path, bytes: 1, sha256: 'b'.repeat(64) })),
})

test('manifest content shape is compatible without claiming authentication', () => {
  const manifest = fixture()
  assert.equal(validateGatewayReleaseManifest(manifest), manifest)
})

test('untrusted paths, duplicate files and incomplete inventories are rejected', () => {
  for (const path of ['payload/../outside.mjs', '/outside.mjs', 'payload/a\\b', 'payload//a', 'payload/./a']) {
    const manifest = fixture(); manifest.files.push({ path, bytes: 1, sha256: 'b'.repeat(64) })
    assert.throws(() => validateGatewayReleaseManifest(manifest), { code: 'GATEWAY_RELEASE_INVENTORY_INVALID' })
  }
  const duplicate = fixture(); duplicate.files.push(duplicate.files[0])
  assert.throws(() => validateGatewayReleaseManifest(duplicate), { code: 'GATEWAY_RELEASE_INVENTORY_INVALID' })
  const missing = fixture(); missing.files.pop()
  assert.throws(() => validateGatewayReleaseManifest(missing), { code: 'GATEWAY_RELEASE_INVENTORY_INVALID' })
})

test('foreign component, entry, platform and parent contract cannot select an executable', () => {
  for (const change of [m => { m.component = 'other' }, m => { m.entry = 'payload/other.mjs' },
    m => { m.runtime.parentProtocol = 2 }, m => { m.runtime.nodeMajor = 25 },
    m => { m.runtime.os = 'unsupported' }, m => { m.runtime.arch = 'unsupported' },
    m => { m.authenticationSucceeded = true }]) {
    const manifest = fixture(); change(manifest)
    assert.throws(() => validateGatewayReleaseManifest(manifest), { code: 'GATEWAY_RELEASE_INCOMPATIBLE' })
  }
})

test('prepare accepts only archive digests and observes cancellation before reading placement', async () => {
  for (const id of ['../x', '/tmp/x', 'latest', 'A'.repeat(64), 'a'.repeat(63)])
    await assert.rejects(prepareGatewayRelease(id), { code: 'GATEWAY_VERSION_INVALID' })
  const controller = new AbortController(); controller.abort()
  await assert.rejects(prepareGatewayRelease('a'.repeat(64), { signal: controller.signal }), { name: 'AbortError' })
})
