import { execFile } from 'node:child_process'
import { createSubmittedSecretApprovalAuthorization } from './submitted-secret-approval.mjs'

// Approval Box-owned public export (bd01); the product checks its own config file before printing.
export const APPROVAL_BOX_CLI = '/home/bell/.approval-box/bin/approval-box'
// Root adopted the independent identity of the preexisting registered connection.
const connectionId = '98867faa-dcef-4262-b961-598d1622c8f7'
const userId = '2f11a5ad-8439-4006-91c4-ea8fd1c3a057'
const denied = () => new Error('SUBMITTED_SECRET_APPROVAL_UNAVAILABLE')
export function exportApprovalBoxConnection({ run = execFile } = {}) {
  return new Promise((resolve, reject) => {
    run(APPROVAL_BOX_CLI, ['connection', 'export', '--json'], { encoding: 'buffer', maxBuffer: 65536, timeout: 30000, windowsHide: true }, (error, stdout) => {
      try {
        if (error || !Buffer.isBuffer(stdout)) return reject(denied())
        const value = JSON.parse(stdout.toString('utf8'))
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'schema,server,token'
          || value.schema !== 'approval-box.connection.v1') return reject(denied())
        resolve(value)
      } catch { reject(denied()) } finally { if (Buffer.isBuffer(stdout)) stdout.fill(0) }
    })
  })
}
export async function verifyRegisteredSubmittedSecretApproval({ readConfig = exportApprovalBoxConnection,
  createAuthorization = createSubmittedSecretApprovalAuthorization, now = Date.now } = {}) {
  const config = await readConfig()
  if (typeof config?.server !== 'string' || config.server.replace(/\/$/u, '') !== 'https://approval-box.kitepon.dev'
    || typeof config.token !== 'string' || !config.token || /[\r\n]/u.test(config.token)) throw denied()
  try {
    const authorize = createAuthorization({ connectionId, userId, expiresAt: new Date(now() + 60000).toISOString(), readBearer: async () => config.token })
    await authorize()
  } finally { config.token = null }
}
