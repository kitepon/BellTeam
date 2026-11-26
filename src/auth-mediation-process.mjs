import { createModuleProcess } from './module-process.mjs'
import { createAuthMediationParentChannel } from './auth-mediation-ipc.mjs'
import { validateAuthMediationReady } from './auth-mediation-protocol.mjs'
import { prepareModuleRelease } from './module-release.mjs'

// Ready probe: root `status {}` answers from memory (ready / no-token), never calls 1Password, so a slow or revoked token cannot fail an exchange.
export function createAuthMediationProcess({ root, onEffect, onGeneration, onState, onModuleChildExit, onModuleRestartLimit, exchangeMutex,
  prepareRelease = (versionId, options) => prepareModuleRelease('auth-mediation', versionId, options), spawnProcess } = {}) {
  return createModuleProcess({ component: 'auth-mediation', root, onGeneration, onState, onModuleChildExit, onModuleRestartLimit, exchangeMutex, spawnProcess,
    createChannel: (child, options) => createAuthMediationParentChannel(child, { ...options, onEffect }),
    validateReady: validateAuthMediationReady, prepareRelease, probeCandidate: channel => channel.request('status', {}) })
}
