import { createModuleProcess } from './module-process.mjs'
import { createWorkGraphParentChannel } from './work-graph-ipc.mjs'
import { validateWorkGraphReady } from './work-graph-protocol.mjs'
import { prepareModuleRelease } from './module-release.mjs'

export function createWorkGraphProcess({ root, onEffect, onState, onModuleChildExit, onModuleRestartLimit, exchangeMutex,
  prepareRelease = (versionId, options) => prepareModuleRelease('work-graph', versionId, options), spawnProcess } = {}) {
  return createModuleProcess({ component: 'work-graph', root, onState, onModuleChildExit, onModuleRestartLimit, exchangeMutex, spawnProcess,
    createChannel: (child, options) => createWorkGraphParentChannel(child, { ...options, onEffect }),
    validateReady: validateWorkGraphReady, prepareRelease, probeCandidate: channel => channel.request('snapshot', {}) })
}
