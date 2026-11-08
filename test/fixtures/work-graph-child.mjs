import { createWorkGraphCore } from '../../src/work-graph/core.mjs'
import { createWorkGraphDispatcher } from '../../src/work-graph-dispatcher.mjs'
import { createWorkGraphChildChannel } from '../../src/work-graph-ipc.mjs'

createWorkGraphChildChannel({ dispatcher: createWorkGraphDispatcher({ core: createWorkGraphCore() }), versionId: null })
