import { createExecutionGeneration } from './execution-generation.mjs'
import { createExecutionFacade } from './execution-facade.mjs'

// The parent supplies durable selection and owns shared native resources.
export function createExecutionAssembly({ ports, loadFactory, onAdopt,
  currentVersionId = null, previousVersionId = null, requestStop, watchQueue, exchangeMutex, onState }) {
  const controller = createExecutionGeneration({ ports, loadFactory, onAdopt,
    currentVersionId, previousVersionId, exchangeMutex, onState })
  const facade = createExecutionFacade({ getController: () => controller, client: ports.native,
    membersAdmission: ports.membersAdmission, requestStop, watchQueue })
  return Object.freeze({ controller, ...facade })
}
