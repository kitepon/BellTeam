import { createExecutionGeneration } from './execution-generation.mjs'
import { createExecutionFacade } from './execution-facade.mjs'

// The parent supplies durable selection and owns shared native resources.
export function createExecutionAssembly({ ports, loadFactory, onAdopt, backgroundSummary = null, requestRestartSummary = null,
  currentVersionId = null, previousVersionId = null, requestStop, watchQueue, exchangeMutex, onModuleRestartLimit, onState }) {
  const controller = createExecutionGeneration({ ports, loadFactory, onAdopt, backgroundSummary, requestRestartSummary,
    currentVersionId, previousVersionId, exchangeMutex, onModuleRestartLimit, onState })
  const facade = createExecutionFacade({ getController: () => controller, client: ports.native,
    membersAdmission: ports.membersAdmission, requestStop, watchQueue })
  return Object.freeze({ controller, ...facade })
}
