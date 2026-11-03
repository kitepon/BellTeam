import { createModuleProcess } from './module-process.mjs'
import { createUsageParentChannel } from './usage/channel.mjs'
import { assertUsageStateCompatibility } from './usage/state-compatibility.mjs'
import { prepareModuleRelease } from './module-release.mjs'

export function createUsageProcess({ root, admission, bootstrap, authorizeActor, onEffect, onProjection,
  onSnapshotStart, onSnapshotEnd, onSnapshotAbort, onDiagnostic, onGeneration, onState,
  prepareRelease = (versionId, options) => prepareModuleRelease('usage', versionId, options), spawnProcess } = {}) {
  if (!admission || typeof authorizeActor !== 'function') throw Object.assign(new Error('USAGE_PORTS_INVALID'), { code: 'USAGE_PORTS_INVALID' })
  const initial = structuredClone(bootstrap)
  return createModuleProcess({ component: 'usage', root, admission, onGeneration, onState, prepareRelease, spawnProcess,
    startPaused: true,
    createChannel: (child, { generation }) => createUsageParentChannel(child, { generation, admission, authorizeActor,
      onEffect, onProjection, onSnapshotStart, onSnapshotEnd, onSnapshotAbort, onDiagnostic }),
    canContinue: (_method, options, generation) => {
      try { admission.assertLease(options.usageLease, { generation }); return true } catch { return false }
    },
    validateReady: ready => {
      if (ready.protocolVersion !== 1) throw Object.assign(new Error('USAGE_READY_INVALID'), { code: 'USAGE_READY_INVALID' })
      assertUsageStateCompatibility(ready.stateCompatibility)
    },
    initializeParams: ({ generation, mode, handoff }) => {
      if (mode === 'restore' && handoff) return { generation, mode, bootstrap: structuredClone(initial), handoff: handoff.handoff }
      if (mode === 'bootstrap' || mode === 'restore') return { generation, mode: 'settings', bootstrap: structuredClone(initial), restore: mode === 'restore' }
      return { generation, mode }
    },
    exportHandoff: channel => channel.control('export', {}, 60000),
  })
}
