import { createAuthMediationService } from './auth-mediation/service.mjs'
import { createAuthMediationDispatcher } from './auth-mediation-dispatcher.mjs'
import { createAuthMediationChildChannel } from './auth-mediation-ipc.mjs'

try {
  if (process.argv.length !== 3 || process.argv[2] !== 'builtin' && !/^[a-f0-9]{64}$/u.test(process.argv[2]))
    throw new Error('AUTH_MEDIATION_ENTRY_INVALID')
  const { AUTH_MEDIATION_STATE, AUTH_MEDIATION_OP, AUTH_MEDIATION_ADMINS } = process.env
  if (!AUTH_MEDIATION_STATE?.startsWith('/')) throw new Error('AUTH_MEDIATION_ENTRY_INVALID')
  const service = createAuthMediationService({ policyPath: `${AUTH_MEDIATION_STATE}/policy.json`, auditPath: `${AUTH_MEDIATION_STATE}/audit.jsonl`,
    opExe: AUTH_MEDIATION_OP ?? '/srv/bellteam/shared/tools/onepassword/bin/op',
    firstAdmins: (AUTH_MEDIATION_ADMINS ?? '').split(',').filter(id => /^[a-z0-9][a-z0-9-]{0,63}$/u.test(id)) })
  createAuthMediationChildChannel({ dispatcher: createAuthMediationDispatcher({ core: service }) })
} catch {
  process.stderr.write('AUTH_MEDIATION_START_FAILED\n')
  process.exitCode = 1
  if (process.connected) process.disconnect()
}
