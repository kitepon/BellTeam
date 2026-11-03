import test from 'node:test'
import assert from 'node:assert/strict'
import { createModuleUpdateCatalog } from '../src/update-module-catalog.mjs'
import { createUpdateCenter } from '../src/update-center.mjs'
import { MEMBERS_STATE_COMPATIBILITY } from '../src/members/state-compatibility.mjs'

const ids = ['web-gateway', 'notifications', 'members']
function selection(id) {
  const source = 'a'.repeat(40), version = 'b'.repeat(64)
  const url = `https://github.com/kitepon/BellTeam/releases/download/updates-20261103T000000Z/${id}-${source}-linux-amd64.tar.gz`
  return { schema: 'bellteam.update-catalog.selection.v1', catalogSha256: 'c'.repeat(64), publishedAt: '2026-11-03T00:00:00Z', expiresAt: '2026-11-04T00:00:00Z',
    publication: { status: 'failed', checkedAt: '2026-11-03T01:00:00Z', error: 'HOST_UPDATE_PUBLICATION_FAILED' },
    release: { componentId: id, sourceCommit: source, versionId: version, platform: { os: 'linux', arch: 'amd64' },
      artifact: { kind: 'archive', archive: { url, sha256: version, bytes: 1000 }, bundle: { url: url + '.sigstore.json', sha256: 'd'.repeat(64), bytes: 100 }, signerCommit: source },
      compatibility: { nodeMajor: 26, parentProtocol: id === 'notifications' ? 2 : 1, stateSchema: id === 'members' ? null : id === 'notifications' ? 2 : 1, containerUpdate: null,
        ...(id === 'members' ? { stateCompatibility: { ...MEMBERS_STATE_COMPATIBILITY } } : {}) }, changes: ['公開版の変更説明'] } }
}
function center(catalog) {
  return createUpdateCenter({ moduleCatalog: createModuleUpdateCatalog({ client: { catalog } }),
    members: { controller: { snapshot: () => ({ available: true, builtinSourceCommit: 'a'.repeat(40), currentVersionId: null }) } } })
}
test('trusted selected module records map to inventory without enabling plans or changing availability', async () => {
  const calls = [], state = await center(async id => { calls.push(id); return selection(id) }).snapshot()
  assert.deepEqual(calls, [...ids, 'memory', 'diagnostics'])
  for (const id of ids) {
    const component = state.components.find(value => value.id === id)
    assert.equal(component.published.version, 'b'.repeat(64))
    assert.equal(component.published.digest, 'sha256:' + 'b'.repeat(64))
    assert.equal(component.publication.check.status, 'failed')
    assert.equal(component.publication.catalog.sha256, 'c'.repeat(64))
    assert.deepEqual(component.capability, { supported: false, reason: 'UPDATE_EXECUTOR_UNAVAILABLE' })
  }
  assert.equal(state.components.find(value => value.id === 'members').comparison.state, 'up_to_date')
  assert.equal(state.components.find(value => value.id === 'members').availability.available, true)
  assert.deepEqual(state.plans, []); assert.equal(state.operation, null)
})
test('missing module catalog stays null and does not turn missing data into latest or idle', async () => {
  const state = await center(async () => { throw Object.assign(new Error(), { code: 'HOST_UPDATE_CATALOG_UNAVAILABLE' }) }).snapshot()
  for (const id of ids) {
    const value = state.components.find(value => value.id === id)
    assert.equal(value.published, null); assert.equal(value.publication, null)
    assert.equal(value.comparison.state, 'unavailable')
    assert.equal(value.capability.reason, 'HOST_UPDATE_CATALOG_UNAVAILABLE')
  }
  assert.equal(state.components.find(value => value.id === 'members').availability.available, true)
})
test('members five keys and actual six state values are exact; old modules keep four keys', async () => {
  const mutations = [
    value => { delete value.release.compatibility.stateCompatibility },
    value => { value.release.compatibility.stateCompatibility.scheduleSchema = 'unknown' },
    value => { value.release.compatibility.stateCompatibility.extra = 1 },
    value => { value.release.compatibility.nodeMajor = '26' },
    value => { value.release.compatibility.stateSchema = 1 },
  ]
  for (const mutate of mutations) {
    const state = await center(async id => { const value = selection(id); if (id === 'members') mutate(value); return value }).snapshot()
    const component = state.components.find(value => value.id === 'members')
    assert.equal(component.published, null); assert.equal(component.capability.reason, 'UPDATE_MODULE_CATALOG_INVALID')
    assert.notEqual(state.components.find(value => value.id === 'notifications').published, null)
  }
  const state = await center(async id => { const value = selection(id); if (id !== 'members') value.release.compatibility.stateCompatibility = MEMBERS_STATE_COMPATIBILITY; return value }).snapshot()
  for (const id of ['web-gateway', 'notifications']) assert.equal(state.components.find(value => value.id === id).published, null)
})
test('selected component, archive digest, immutable URL and publication shape are validated', async () => {
  for (const mutate of [value => { value.release.componentId = 'container' }, value => { value.release.artifact.archive.sha256 = '0'.repeat(64) },
    value => { value.release.artifact.archive.url = 'https://example.com/archive.tar.gz' }, value => { value.publication.extra = true }]) {
    const state = await center(async id => { const value = selection(id); if (id === 'members') mutate(value); return value }).snapshot()
    assert.equal(state.components.find(value => value.id === 'members').published, null)
    assert.equal(state.components.find(value => value.id === 'members').comparison.state, 'unavailable')
  }
})
test('no published release is distinct from incompatible module metadata', async () => {
  const state = await center(async id => { const value = selection(id); if (id === 'members') value.release = null; else value.release.compatibility.parentProtocol = 2; return value }).snapshot()
  const member = state.components.find(value => value.id === 'members'), web = state.components.find(value => value.id === 'web-gateway')
  assert.equal(member.published, null); assert.notEqual(member.publication, null)
  assert.equal(web.comparison.state, 'incompatible'); assert.equal(web.capability.supported, false)
})
