import { createDiagnosticsDispatcher } from './diagnostics-dispatcher.mjs'
import { createDiagnosticsChildChannel } from './diagnostics-ipc.mjs'
import { verifyDiagnosticsLocks } from './diagnostics-locks.mjs'

try {
  if (process.argv.length !== 3 || process.argv[2] !== 'builtin' && !/^[a-f0-9]{64}$/u.test(process.argv[2]))
    throw new Error('DIAGNOSTICS_ENTRY_INVALID')
  verifyDiagnosticsLocks()
  const dispatcher = createDiagnosticsDispatcher({ root: '/srv/bellteam',
    investigationsFile: process.env.BELLTEAM_DIAGNOSTIC_INVESTIGATIONS || null })
  createDiagnosticsChildChannel({ dispatcher })
} catch {
  process.stderr.write('DIAGNOSTICS_START_FAILED\n')
  process.exitCode = 1
  if (process.connected) process.disconnect()
}
