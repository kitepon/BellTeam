import { createExecutionGeneration } from './execution-generation.mjs'
import { createExecutionFacade } from './execution-facade.mjs'
import { UpdateHold } from './update-hold.mjs'
import { dirname, join } from 'node:path'

// The parent supplies durable selection and owns shared native resources.
export function createExecutionAssembly({ ports, loadFactory, onAdopt, backgroundSummary = null, requestRestartSummary = null,
  currentVersionId = null, previousVersionId = null, requestStop, watchQueue, exchangeMutex, onModuleRestartLimit, onState }) {
  // Z-c: the update hold outlives engine exchanges, so it lives here (update-hold.md).
  let controller
  const hold = new UpdateHold({ path: join(dirname(ports.configurationStorage.root), 'execution-update-hold.json'),
    active: () => { try { return controller.project({ method: 'transport.queueItems', args: [] }) } catch { return [] } },
    report: error => ports.diagnostics?.record?.({ code: 'UPDATE_HOLD_RELEASE_FAILED', module: 'execution', diagnostic_log: String(error?.code ?? error?.message ?? '') }) })
  const gatedPorts = { ...ports, access: { ...ports.access, assertInput: () => hold.assertInput() } }
  // An older selected engine rejects unknown port keys; it keeps only the facade guard (update-hold.md).
  const gatedFactory = async (...args) => {
    const factory = await loadFactory(...args)
    return Object.freeze({ ...factory, createExecutionDispatcher: input => factory.createExecutionDispatcher(
      factory.supportsUpdateHold === true ? { ...input, ports: { ...input.ports, access: gatedPorts.access } } : input) })
  }
  controller = createExecutionGeneration({ ports, loadFactory: gatedFactory, onAdopt, backgroundSummary, requestRestartSummary,
    currentVersionId, previousVersionId, exchangeMutex, onModuleRestartLimit, onState })
  const facade = createExecutionFacade({ getController: () => controller, client: ports.native,
    membersAdmission: ports.membersAdmission, requestStop, watchQueue, hold })
  const lifecycle = Object.freeze({
    quiesce: input => hold.quiesce(input),
    // The controller started (and R-resume reconnected) before listen; a hold saved by the replaced box ends here.
    afterListenReady: () => hold.release('startup'),
    onShutdownSignal: () => hold.onShutdownSignal(),
  })
  return Object.freeze({ controller, ...facade, lifecycle,
    hold: Object.freeze({ initialize: () => hold.initialize(), get held() { return hold.held }, watch: listener => hold.watch(listener) }) })
}
