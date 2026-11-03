import { prepareMemoryRelease as prepare } from './web-gateway-release.mjs'
import { assertMemoryStateCompatibility } from './memory/state-compatibility.mjs'
export { validateMemoryReleaseManifest } from './web-gateway-release.mjs'

export async function prepareMemoryRelease(versionId, options = {}) {
  const descriptor = await prepare(versionId, options), release = options.expectedRelease
  if (release) {
    const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).sort().join(',') === fields.split(',').sort().join(',')
    if (!exact(release, 'componentId,sourceCommit,versionId,platform,artifact,compatibility,changes')
      || release.componentId !== 'memory' || release.versionId !== descriptor.versionId || release.sourceCommit !== descriptor.sourceCommit
      || !exact(release.platform, 'os,arch') || release.platform.os !== descriptor.platform.os || release.platform.arch !== descriptor.platform.arch
      || !exact(release.compatibility, 'nodeMajor,parentProtocol,stateSchema,containerUpdate,stateCompatibility')
      || release.compatibility.nodeMajor !== 26 || release.compatibility.parentProtocol !== 1
      || release.compatibility.stateSchema !== null || release.compatibility.containerUpdate !== null
      || release.artifact?.kind !== 'archive' || release.artifact.archive?.sha256 !== descriptor.versionId)
      throw Object.assign(new Error('MEMORY_CATALOG_INCOMPATIBLE'), { code: 'MEMORY_CATALOG_INCOMPATIBLE' })
    assertMemoryStateCompatibility(release.compatibility.stateCompatibility)
  }
  return descriptor
}
