import { createDiagnosticsDispatcher } from '../../src/diagnostics-dispatcher.mjs'
import { createDiagnosticsChildChannel } from '../../src/diagnostics-ipc.mjs'

const dispatcher = createDiagnosticsDispatcher({ root: process.argv[2] })
createDiagnosticsChildChannel({ dispatcher, versionId: null })
