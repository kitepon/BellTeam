import { createApprovalBoxExtensionCore } from './approval-box-extension/core.mjs'
import { createApprovalsDispatcher } from './approval-box-extension-dispatcher.mjs'
import { createApprovalsChildChannel } from './approval-box-extension-ipc.mjs'
import { verifyApprovalBoxExtensionLocks } from './approval-box-extension-locks.mjs'

try {
  if (process.argv.length !== 3 || process.argv[2] !== 'builtin' && !/^[a-f0-9]{64}$/u.test(process.argv[2])) throw new Error('APPROVALS_ENTRY_INVALID')
  verifyApprovalBoxExtensionLocks()
  createApprovalsChildChannel({ dispatcher: createApprovalsDispatcher({ core: createApprovalBoxExtensionCore() }) })
} catch {
  process.stderr.write('APPROVALS_START_FAILED\n')
  process.exitCode = 1
  if (process.connected) process.disconnect()
}
