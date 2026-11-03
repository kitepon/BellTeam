import { prepareBusinessModuleRelease, validateBusinessModuleManifest } from './web-gateway-release.mjs'
import { assertUsageStateCompatibility } from './usage/state-compatibility.mjs'
import { assertDiagnosticsStateCompatibility } from './diagnostics-protocol.mjs'

const validators = Object.freeze({ usage: assertUsageStateCompatibility, diagnostics: assertDiagnosticsStateCompatibility })
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === names.split(',').sort().join(',')
const checkComponent = component => {
  if (!Object.hasOwn(validators, component)) throw Object.assign(new Error('MODULE_RELEASE_COMPONENT_INVALID'), { code: 'MODULE_RELEASE_COMPONENT_INVALID' })
}

export function assertModuleCatalogRelease(component, release, descriptor) {
  checkComponent(component)
  const fail = () => { throw Object.assign(new Error(`${component.toUpperCase()}_CATALOG_INCOMPATIBLE`), { code: `${component.toUpperCase()}_CATALOG_INCOMPATIBLE` }) }
  if (!exact(release, 'componentId,sourceCommit,versionId,platform,artifact,compatibility,changes')
    || release.componentId !== component || release.versionId !== descriptor.versionId || release.sourceCommit !== descriptor.sourceCommit
    || !exact(release.platform, 'os,arch') || release.platform.os !== descriptor.platform?.os || release.platform.arch !== descriptor.platform?.arch
    || !exact(release.compatibility, 'nodeMajor,parentProtocol,stateSchema,containerUpdate,stateCompatibility')
    || release.compatibility.nodeMajor !== 26 || release.compatibility.parentProtocol !== 1
    || release.compatibility.stateSchema !== null || release.compatibility.containerUpdate !== null
    || release.artifact?.kind !== 'archive' || release.artifact.archive?.sha256 !== descriptor.versionId) fail()
  validators[component](release.compatibility.stateCompatibility)
  validators[component](descriptor.stateCompatibility)
  return descriptor
}

export async function prepareModuleRelease(component, versionId, options = {}) {
  checkComponent(component)
  const descriptor = await prepareBusinessModuleRelease(component, versionId, options)
  if (options.expectedRelease) assertModuleCatalogRelease(component, options.expectedRelease, descriptor)
  return descriptor
}

export { validateBusinessModuleManifest as validateModuleReleaseManifest }
