import { createModuleProcess } from './module-process.mjs'
import { createDiagnosticsParentChannel } from './diagnostics-ipc.mjs'
import { validateDiagnosticsReady } from './diagnostics-protocol.mjs'
import { prepareModuleRelease } from './module-release.mjs'

export function createDiagnosticsProcess({ root, investigationsFile = null, onState, exchangeMutex,
  prepareRelease = (versionId, options) => prepareModuleRelease('diagnostics', versionId, options), spawnProcess } = {}) {
  return createModuleProcess({ component: 'diagnostics', root, investigationsFile, onState, exchangeMutex, spawnProcess,
    createChannel: createDiagnosticsParentChannel, validateReady: validateDiagnosticsReady, prepareRelease })
}
