import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { prepareExecutionRelease } from './web-gateway-release.mjs'

const failure = code => Object.assign(new Error(code), { code, status: 503, outcome: 'not_accepted' })
const builtinURL = new URL('file:///app/src/execution-dispatcher.mjs')
const sourceValid = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value)
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === fields.split(',').sort().join(',')

async function readBuiltinIdentity() {
  const file = await open('/app/distribution.json', constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || info.mode & 0o22 || info.size > 4096)
      throw failure('EXECUTION_BUILTIN_IDENTITY_INVALID')
    const value = JSON.parse(await file.readFile('utf8'))
    if (value.schema !== 'bellteam.server.distribution.v1' || !sourceValid(value.sourceCommit))
      throw failure('EXECUTION_BUILTIN_IDENTITY_INVALID')
    return value.sourceCommit
  } finally { await file.close() }
}

function assertCatalog(release, descriptor, stateCompatibility) {
  if (!exact(release, 'componentId,sourceCommit,versionId,platform,artifact,compatibility,changes')
    || release.componentId !== 'execution' || release.versionId !== descriptor.versionId || release.sourceCommit !== descriptor.sourceCommit
    || !exact(release.platform, 'os,arch') || release.platform.os !== descriptor.platform?.os || release.platform.arch !== descriptor.platform?.arch
    || !exact(release.compatibility, 'nodeMajor,parentProtocol,stateSchema,containerUpdate,stateCompatibility')
    || release.compatibility.nodeMajor !== 26 || release.compatibility.parentProtocol !== 1
    || release.compatibility.stateSchema !== null || release.compatibility.containerUpdate !== null
    || release.compatibility.stateCompatibility !== stateCompatibility
    || release.artifact?.kind !== 'archive' || release.artifact.archive?.sha256 !== descriptor.versionId)
    throw failure('EXECUTION_CATALOG_INCOMPATIBLE')
}
const validateNamespace = value => {
  if (typeof value?.createExecutionDispatcher !== 'function' || typeof value.EXECUTION_STATE_COMPATIBILITY !== 'string'
    || !value.EXECUTION_STATE_COMPATIBILITY || value.EXECUTION_STATE_COMPATIBILITY.length > 128)
    throw failure('EXECUTION_FACTORY_INVALID')
  return value
}

// Test ports replace I/O, while path selection remains closed in every instance.
export function createExecutionFactoryLoader({ prepareRelease = prepareExecutionRelease,
  importFactory = url => import(url), builtinIdentity = readBuiltinIdentity } = {}) {
  return async (versionId = null, { expectedRelease } = {}) => {
    if (versionId !== null && (typeof versionId !== 'string' || !/^[a-f0-9]{64}$/u.test(versionId)))
      throw failure('EXECUTION_VERSION_INVALID')
    const expected = expectedRelease ? structuredClone(expectedRelease) : undefined
    const builtin = validateNamespace(await importFactory(builtinURL.href))
    let namespace = builtin, sourceCommit
    if (versionId === null) {
      if (expected) throw failure('EXECUTION_BUILTIN_EXPECTATION_INVALID')
      sourceCommit = await builtinIdentity()
      if (!sourceValid(sourceCommit)) throw failure('EXECUTION_BUILTIN_IDENTITY_INVALID')
    } else {
      const descriptor = await prepareRelease(versionId)
      const appRoot = `/run/bellteam-maintenance/execution/releases/${versionId}/payload`
      if (descriptor?.versionId !== versionId || descriptor.appRoot !== appRoot || descriptor.protocolVersion !== 1
        || descriptor.platform?.os !== process.platform || descriptor.platform?.arch !== ({ x64: 'amd64', arm64: 'arm64' })[process.arch]
        || !sourceValid(descriptor.sourceCommit) || descriptor.stateCompatibility !== builtin.EXECUTION_STATE_COMPATIBILITY)
        throw failure('EXECUTION_RELEASE_INVALID')
      if (expected) assertCatalog(expected, descriptor, builtin.EXECUTION_STATE_COMPATIBILITY)
      namespace = validateNamespace(await importFactory(pathToFileURL(`${appRoot}/src/execution-dispatcher.mjs`).href))
      if (namespace.EXECUTION_STATE_COMPATIBILITY !== builtin.EXECUTION_STATE_COMPATIBILITY)
        throw failure('EXECUTION_STATE_INCOMPATIBLE')
      sourceCommit = descriptor.sourceCommit
    }
    return Object.freeze({ versionId, sourceCommit, createExecutionDispatcher: namespace.createExecutionDispatcher,
      supportsModelHandoff: Array.isArray(namespace.EXECUTION_METHODS?.dispatch)
        && namespace.EXECUTION_METHODS.dispatch.includes('administration.configureFromMcp'),
      supportsUpdateHold: namespace.EXECUTION_UPDATE_HOLD_GATE === true,
      supportsRemoteSeats: namespace.EXECUTION_REMOTE_SEATS === true,
      supportsSeatMcpSeen: namespace.EXECUTION_SEAT_MCP_SEEN === true })
  }
}

export const loadExecutionFactory = createExecutionFactoryLoader()
