import { createDiagnosticsDispatcher } from '../../src/diagnostics-dispatcher.mjs'
import { createDiagnosticsChildChannel } from '../../src/diagnostics-ipc.mjs'

const dispatcher = createDiagnosticsDispatcher({ root: process.argv[2],
  investigationsFile: process.env.BELLTEAM_DIAGNOSTIC_INVESTIGATIONS || null })
createDiagnosticsChildChannel({ dispatcher, versionId: !process.argv[3] || process.argv[3] === 'builtin' ? null : process.argv[3] })
