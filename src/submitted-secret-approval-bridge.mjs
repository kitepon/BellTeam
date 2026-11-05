import { fileURLToPath } from 'node:url'
import { createSeatProcessRunner } from './seat-process.mjs'
const script = fileURLToPath(new URL('../scripts/verify-submitted-secret-approval.mjs', import.meta.url))
const denied = () => new Error('SUBMITTED_SECRET_APPROVAL_UNAVAILABLE')
// Only the credential's existing UID1000 owner reads it; no token crosses back to management.
export function createSubmittedSecretApprovalBridge({ project, run = createSeatProcessRunner(project, { environment: 'base' }) }) {
  return async () => {
    try {
      const result = await run(process.execPath, [script], { signal: AbortSignal.timeout(65000), maxBuffer: 4096 })
      if (result.stderr !== '') throw denied()
      const value = JSON.parse(result.stdout)
      if (!value || Object.keys(value).sort().join(',') !== 'authorized,schema'
        || value.schema !== 'bellteam.submitted-secret-approval.v1' || value.authorized !== true) throw denied()
    } catch { throw denied() }
  }
}
