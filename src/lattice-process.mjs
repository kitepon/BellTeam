import { createModuleProcess } from './module-process.mjs'
import { createLatticeParentChannel } from './lattice-ipc.mjs'
import { validateLatticeReady } from './lattice-protocol.mjs'
import { prepareModuleRelease } from './module-release.mjs'

// Ready probe: a refresh of a chart id nobody uses answers without spawning the Lattice CLI, so a slow chart cannot fail an exchange.
const PROBE = { projectIds: ['bellteam-ready-probe'] }

export function createLatticeProcess({ root, onEffect, onGeneration, onState, onModuleChildExit, onModuleRestartLimit, exchangeMutex,
  prepareRelease = (versionId, options) => prepareModuleRelease('lattice', versionId, options), spawnProcess } = {}) {
  return createModuleProcess({ component: 'lattice', root, onGeneration, onState, onModuleChildExit, onModuleRestartLimit, exchangeMutex, spawnProcess,
    createChannel: (child, options) => createLatticeParentChannel(child, { ...options, onEffect }),
    validateReady: validateLatticeReady, prepareRelease, probeCandidate: channel => channel.request('refresh', PROBE) })
}
