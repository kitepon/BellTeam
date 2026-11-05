import { verifyRegisteredSubmittedSecretApproval } from '../src/submitted-secret-approval-owner.mjs'
let authorized = false
if (process.argv.length === 2) {
  try { await verifyRegisteredSubmittedSecretApproval(); authorized = true } catch {}
}
process.stdout.write(JSON.stringify({ schema: 'bellteam.submitted-secret-approval.v1', authorized }) + '\n')
