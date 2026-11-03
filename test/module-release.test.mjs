import assert from 'node:assert/strict'
import test from 'node:test'
import { validateModuleReleaseManifest, assertModuleCatalogRelease, prepareModuleRelease } from '../src/module-release.mjs'
import { USAGE_STATE_COMPATIBILITY } from '../src/usage/state-compatibility.mjs'
import { DIAGNOSTICS_STATE_COMPATIBILITY } from '../src/diagnostics-protocol.mjs'

const compatibility = { usage: USAGE_STATE_COMPATIBILITY, diagnostics: DIAGNOSTICS_STATE_COMPATIBILITY }
function fixture(component) {
  const names = component === 'usage'
    ? ['usage/channel', 'usage/channel-dispatcher', 'usage/services', 'usage/state-compatibility', 'usage-locks']
    : ['diagnostics-ipc', 'diagnostics-dispatcher', 'diagnostics-protocol', 'diagnostics-locks']
  return { schema: `bellteam.${component}.artifact.v1`, component, sourceCommit: 'a'.repeat(40),
    entry: `payload/src/${component}-entry.mjs`,
    runtime: { os: process.platform, arch: ({ x64: 'amd64', arm64: 'arm64' })[process.arch], nodeMajor: 26,
      parentProtocol: 1, stateCompatibility: structuredClone(compatibility[component]) },
    files: [`payload/src/${component}-entry.mjs`, 'payload/package.json', 'payload/package-lock.json',
      ...[...names, 'module-ipc', 'module-streams', 'module-locks'].map(name => `payload/src/${name}.mjs`)]
      .map(path => ({ path, bytes: 1, sha256: 'b'.repeat(64) })),
  }
}
for (const component of ['usage', 'diagnostics']) {
  test(`${component} manifest keeps the real compatibility and the entry/channel/lock closure`, () => {
    const value = fixture(component)
    assert.equal(validateModuleReleaseManifest(component, value), value)
    for (const mutate of [
      m => { m.runtime.parentProtocol = 2 }, m => { m.runtime.stateCompatibility.extra = 'unknown' },
      m => { m.entry = 'payload/src/other.mjs' }, m => { m.files.pop() },
      m => { m.files.push(m.files[0]) }, m => { m.files[0].path = 'payload/../outside' },
    ]) {
      const changed = structuredClone(value); mutate(changed)
      assert.throws(() => validateModuleReleaseManifest(component, changed))
    }
  })
  test(`${component} catalog binds source, platform, archive and actual storage fields`, () => {
    const descriptor = { versionId: 'b'.repeat(64), sourceCommit: 'a'.repeat(40),
      platform: { os: process.platform, arch: ({ x64: 'amd64', arm64: 'arm64' })[process.arch] },
      stateCompatibility: structuredClone(compatibility[component]) }
    const release = { componentId: component, sourceCommit: descriptor.sourceCommit, versionId: descriptor.versionId,
      platform: descriptor.platform, artifact: { kind: 'archive', archive: { sha256: descriptor.versionId } }, changes: [],
      compatibility: { nodeMajor: 26, parentProtocol: 1, stateSchema: null, containerUpdate: null, stateCompatibility: descriptor.stateCompatibility } }
    assert.equal(assertModuleCatalogRelease(component, release, descriptor), descriptor)
    for (const mutate of [
      r => { r.sourceCommit = 'c'.repeat(40) }, r => { r.platform.arch = 'unsupported' },
      r => { r.artifact.archive.sha256 = 'c'.repeat(64) }, r => { r.compatibility.stateSchema = 1 },
      r => { r.compatibility.stateCompatibility.extra = 'unknown' }, r => { r.componentId = 'other' },
    ]) {
      const changed = structuredClone(release); mutate(changed)
      assert.throws(() => assertModuleCatalogRelease(component, changed, descriptor))
    }
  })
}
test('module reader refuses an arbitrary component, version path and cancelled placement read', async () => {
  assert.throws(() => validateModuleReleaseManifest('../other', {}), /COMPONENT_INVALID/)
  await assert.rejects(prepareModuleRelease('other', 'b'.repeat(64)), /COMPONENT_INVALID/)
  await assert.rejects(prepareModuleRelease('diagnostics', '../elsewhere'), /VERSION_INVALID/)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(prepareModuleRelease('usage', 'b'.repeat(64), { signal: abort.signal }), { name: 'AbortError' })
})
