import assert from 'node:assert/strict'
import test from 'node:test'
import { validateModuleReleaseManifest, assertModuleCatalogRelease, prepareModuleRelease } from '../src/module-release.mjs'
import { USAGE_STATE_COMPATIBILITY } from '../src/usage/state-compatibility.mjs'
import { DIAGNOSTICS_STATE_COMPATIBILITY } from '../src/diagnostics-protocol.mjs'
import { CONVERSATION_STATE_COMPATIBILITY } from '../src/conversation/state-compatibility.mjs'

const compatibility = { usage: USAGE_STATE_COMPATIBILITY, diagnostics: DIAGNOSTICS_STATE_COMPATIBILITY, conversation: CONVERSATION_STATE_COMPATIBILITY }
function fixture(component) {
  const names = component === 'conversation'
    ? ['conversation-ipc', 'conversation-channel', 'conversation/dispatcher', 'conversation/state-compatibility', 'conversation-locks', 'conversation-streams'] : component === 'usage'
    ? ['usage/channel', 'usage/channel-dispatcher', 'usage/services', 'usage/state-compatibility', 'usage-locks']
    : ['diagnostics-ipc', 'diagnostics-dispatcher', 'diagnostics-protocol', 'diagnostics-locks']
  return { schema: `bellteam.${component}.artifact.v1`, component, sourceCommit: 'a'.repeat(40),
    entry: `payload/src/${component}-entry.mjs`,
    runtime: { os: process.platform, arch: ({ x64: 'amd64', arm64: 'arm64' })[process.arch], nodeMajor: 26,
      parentProtocol: 1, ...(component === 'conversation' ? { stateSchema: null } : {}), stateCompatibility: structuredClone(compatibility[component]) },
    files: [`payload/src/${component}-entry.mjs`, 'payload/package.json', 'payload/package-lock.json',
      ...[...names, ...(component === 'conversation' ? ['module-streams'] : ['module-ipc', 'module-streams', 'module-locks'])].map(name => `payload/src/${name}.mjs`)]
      .map(path => ({ path, bytes: 1, sha256: 'b'.repeat(64) })),
  }
}
for (const component of ['usage', 'diagnostics', 'conversation']) {
  test(`${component} manifest keeps the real compatibility and the entry/channel/lock closure`, () => {
    const value = fixture(component)
    assert.equal(validateModuleReleaseManifest(component, value), value)
    if (component === 'conversation') {
      const changed = structuredClone(value); delete changed.runtime.stateSchema
      assert.throws(() => validateModuleReleaseManifest(component, changed))
      changed.runtime.stateSchema = 1
      assert.throws(() => validateModuleReleaseManifest(component, changed))
    }
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
    if (component === 'conversation') descriptor.stateSchema = null
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
