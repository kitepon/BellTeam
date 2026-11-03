import { prepareNotificationsRelease as prepare } from './web-gateway-release.mjs'
export { validateNotificationsReleaseManifest } from './web-gateway-release.mjs'

export function assertNotificationsCatalogRelease(release, descriptor) {
  const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === fields.split(',').sort().join(',')
  if (!exact(release, 'componentId,sourceCommit,versionId,platform,artifact,compatibility,changes')
    || release.componentId !== 'notifications' || release.versionId !== descriptor.versionId || release.sourceCommit !== descriptor.sourceCommit
    || !exact(release.platform, 'os,arch') || release.platform.os !== descriptor.platform?.os || release.platform.arch !== descriptor.platform?.arch
    || !exact(release.compatibility, 'nodeMajor,parentProtocol,stateSchema,containerUpdate')
    || release.compatibility.nodeMajor !== 26 || release.compatibility.parentProtocol !== 2 || release.compatibility.stateSchema !== 2
    || release.compatibility.containerUpdate !== null || descriptor.protocolVersion !== 2 || descriptor.stateSchema !== 2
    || release.artifact?.kind !== 'archive' || release.artifact.archive?.sha256 !== descriptor.versionId)
    throw Object.assign(new Error('NOTIFICATIONS_CATALOG_INCOMPATIBLE'), { code: 'NOTIFICATIONS_CATALOG_INCOMPATIBLE' })
  return descriptor
}

export async function prepareNotificationsRelease(versionId, options = {}) {
  const descriptor = await prepare(versionId, options)
  if (options.expectedRelease) assertNotificationsCatalogRelease(options.expectedRelease, descriptor)
  return descriptor
}
