import { createWorkGraphCore } from './work-graph/core.mjs'
import { createWorkGraphDispatcher } from './work-graph-dispatcher.mjs'
import { createWorkGraphChildChannel } from './work-graph-ipc.mjs'
import { verifyWorkGraphLocks } from './work-graph-locks.mjs'

try {
  if (process.argv.length !== 3 || process.argv[2] !== 'builtin' && !/^[a-f0-9]{64}$/u.test(process.argv[2]))
    throw new Error('WORK_GRAPH_ENTRY_INVALID')
  verifyWorkGraphLocks()
  const dispatcher = createWorkGraphDispatcher({ core: createWorkGraphCore() })
  createWorkGraphChildChannel({ dispatcher })
} catch {
  process.stderr.write('WORK_GRAPH_START_FAILED\n')
  process.exitCode = 1
  if (process.connected) process.disconnect()
}
