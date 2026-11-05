import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { createSubmittedSecretApprovalAuthorization } from './submitted-secret-approval.mjs'

export const APPROVAL_CONFIG = '/home/bell/.approval-box/config.json'
// Root adopted the independent identity of the preexisting registered connection.
const connectionId = '98867faa-dcef-4262-b961-598d1622c8f7'
const userId = '2f11a5ad-8439-4006-91c4-ea8fd1c3a057'
const denied = () => new Error('SUBMITTED_SECRET_APPROVAL_UNAVAILABLE')
export async function verifyRegisteredSubmittedSecretApproval({ readConfig = async () => {
  if (process.getuid() !== 1000 || await realpath(APPROVAL_CONFIG) !== APPROVAL_CONFIG) throw denied()
  const file = await open(APPROVAL_CONFIG, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.uid !== 1000 || before.gid !== 1000 || before.nlink !== 1
      || (before.mode & 0o7777) !== 0o600 || before.size < 1 || before.size > 65536) throw denied()
    const bytes = Buffer.alloc(before.size + 1)
    try {
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0), after = await file.stat()
      if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw denied()
      return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))
    } finally { bytes.fill(0) }
  } finally { await file.close() }
}, createAuthorization = createSubmittedSecretApprovalAuthorization, now = Date.now } = {}) {
  const config = await readConfig()
  if (typeof config?.server !== 'string' || config.server.replace(/\/$/u, '') !== 'https://approval-box.kitepon.dev'
    || typeof config.token !== 'string' || !config.token || /[\r\n]/u.test(config.token)) throw denied()
  try {
    const authorize = createAuthorization({ connectionId, userId, expiresAt: new Date(now() + 60000).toISOString(), readBearer: async () => config.token })
    await authorize()
  } finally { config.token = null }
}
