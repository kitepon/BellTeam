import { createModuleProcess } from './module-process.mjs'
import { createApprovalsParentChannel } from './approval-box-extension-ipc.mjs'
import { validateApprovalsReady } from './approval-box-extension-protocol.mjs'
import { prepareModuleRelease } from './module-release.mjs'

// Ready probe (Delta): `connection {}` answers from memory, never calls the network, so a slow Approval Box cannot fail an exchange.
export function createApprovalBoxExtensionProcess({ root, onEffect, onGeneration, onState, onModuleChildExit, onModuleRestartLimit, exchangeMutex,
  prepareRelease = (versionId, options) => prepareModuleRelease('approval-box-extension', versionId, options), spawnProcess } = {}) {
  return createModuleProcess({ component: 'approval-box-extension', root, onGeneration, onState, onModuleChildExit, onModuleRestartLimit, exchangeMutex, spawnProcess,
    createChannel: (child, options) => createApprovalsParentChannel(child, { ...options, onEffect }),
    validateReady: validateApprovalsReady, prepareRelease, probeCandidate: channel => channel.request('connection', {}) })
}
