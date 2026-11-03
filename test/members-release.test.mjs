import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareMembersRelease, validateMembersReleaseManifest, assertMembersCatalogRelease } from '../src/members-release.mjs'
import { MEMBERS_STATE_COMPATIBILITY } from '../src/members/state-compatibility.mjs'

const manifest = () => ({ schema: 'bellteam.members.artifact.v1', component: 'members', sourceCommit: 'a'.repeat(40),
  entry: 'payload/src/members-entry.mjs', runtime: { os: process.platform, arch: { x64: 'amd64', arm64: 'arm64' }[process.arch],
    nodeMajor: 26, parentProtocol: 1, stateCompatibility: structuredClone(MEMBERS_STATE_COMPATIBILITY) },
  files: ['payload/src/members-entry.mjs', 'payload/package.json', 'payload/package-lock.json',
    'payload/config/common-agents.md', 'payload/src/members/state-compatibility.mjs']
    .map(path => ({ path, bytes: 1, sha256: 'b'.repeat(64) })) })

test('members signed content must declare the exact six current state formats and fixed instruction assets', () => {
  const good = manifest(); assert.equal(validateMembersReleaseManifest(good), good)
  for (const mutate of [value => delete value.runtime.stateCompatibility.botProfileSchema,
    value => { value.runtime.stateCompatibility.botProfileSchema = 'unknown' },
    value => { value.runtime.stateSchema = 1 }, value => value.files.pop(),
    value => { value.entry = 'payload/src/notifications-entry.mjs' }]) {
    const value = manifest(); mutate(value); assert.throws(() => validateMembersReleaseManifest(value))
  }
})

test('members reader rejects arbitrary paths or cancellation before store access', async () => {
  await assert.rejects(prepareMembersRelease('/tmp/arbitrary'))
  await assert.rejects(prepareMembersRelease('a'.repeat(64), { signal: AbortSignal.abort() }), { name: 'AbortError' })
})

test('catalog, signed archive descriptor and supported consumer must agree exactly', () => {
  const descriptor = { versionId: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), platform: { os: 'linux', arch: 'amd64' },
    stateCompatibility: structuredClone(MEMBERS_STATE_COMPATIBILITY) }
  const release = { componentId: 'members', versionId: descriptor.versionId, sourceCommit: descriptor.sourceCommit,
    platform: descriptor.platform, changes: [], artifact: { kind: 'archive', archive: { sha256: descriptor.versionId } },
    compatibility: { nodeMajor: 26, parentProtocol: 1, stateSchema: null, containerUpdate: null, stateCompatibility: descriptor.stateCompatibility } }
  assert.equal(assertMembersCatalogRelease(release, descriptor), descriptor)
  for (const mutate of [value => { value.sourceCommit = 'c'.repeat(40) }, value => { value.platform.arch = 'arm64' },
    value => { value.compatibility.stateSchema = 1 }, value => { value.compatibility.stateCompatibility = null },
    value => { value.compatibility.extra = true }, value => { value.versionId = 'c'.repeat(64) }]) {
    const wrong = structuredClone(release); mutate(wrong)
    assert.throws(() => assertMembersCatalogRelease(wrong, descriptor))
  }
  assert.throws(() => assertMembersCatalogRelease(release, { ...descriptor, stateCompatibility: null }))
})
