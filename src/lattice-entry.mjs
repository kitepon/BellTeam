import { createLatticeCore } from './lattice/core.mjs'
import { createLatticeCli } from './lattice/cli.mjs'
import { createLatticeDispatcher } from './lattice-dispatcher.mjs'
import { createLatticeChildChannel } from './lattice-ipc.mjs'

try {
  if (process.argv.length !== 3 || process.argv[2] !== 'builtin' && !/^[a-f0-9]{64}$/u.test(process.argv[2]))
    throw new Error('LATTICE_ENTRY_INVALID')
  // Molly's registration adds verifyLatticeLocks() here (module-locks).
  const dispatcher = createLatticeDispatcher({ core: createLatticeCore({ cli: createLatticeCli() }) })
  createLatticeChildChannel({ dispatcher })
} catch {
  process.stderr.write('LATTICE_START_FAILED\n')
  process.exitCode = 1
  if (process.connected) process.disconnect()
}
