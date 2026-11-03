import { prepareMembersRelease as prepare } from './web-gateway-release.mjs'
import { assertMembersStateCompatibility } from './members/state-compatibility.mjs'
export { validateMembersReleaseManifest } from './web-gateway-release.mjs'

export function assertMembersCatalogRelease(release, descriptor) {
  const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === names.split(',').sort().join(',')
  const fail = () => { throw Object.assign(new Error('MEMBERS_CATALOG_INCOMPATIBLE'), { code: 'MEMBERS_CATALOG_INCOMPATIBLE' }) }
  if (!exact(release, 'componentId,sourceCommit,versionId,platform,artifact,compatibility,changes')
    || release.componentId !== 'members' || release.versionId !== descriptor.versionId || release.sourceCommit !== descriptor.sourceCommit
    || !exact(release.platform, 'os,arch') || release.platform.os !== descriptor.platform?.os || release.platform.arch !== descriptor.platform?.arch
    || !exact(release.compatibility, 'nodeMajor,parentProtocol,stateSchema,containerUpdate,stateCompatibility')
    || release.compatibility.nodeMajor !== 26 || release.compatibility.parentProtocol !== 1
    || release.compatibility.stateSchema !== null || release.compatibility.containerUpdate !== null
    || release.artifact?.kind !== 'archive' || release.artifact.archive?.sha256 !== descriptor.versionId) fail()
  assertMembersStateCompatibility(release.compatibility.stateCompatibility)
  assertMembersStateCompatibility(descriptor.stateCompatibility)
  return descriptor
}

export async function prepareMembersRelease(versionId, options = {}) {
  const descriptor = await prepare(versionId, options)
  if (options.expectedRelease) assertMembersCatalogRelease(options.expectedRelease, descriptor)
  return descriptor
}
