import { createOlrwAuthorization } from './olrw-management-caller.mjs'

// Original pre-request specs; never derived from a current decision response.
const expected = [
  {
    "decisionId": "K-3JM9PS",
    "version": 3,
    "optionId": "start_now",
    "requester": "トロニー",
    "contextSha256": "460d16ba1332d73f42dbe0fbda1f1f19f0101e41da3572b7754711e7ec65ae75",
    "optionsSha256": "f624f7a8511ddeec85c4d4c53057c081db4d517355ad8014c579f33c466efe76"
  },
  {
    "decisionId": "K-6782UM",
    "version": 3,
    "optionId": "entered_secret",
    "requester": "センチ",
    "contextSha256": "91946b929c7700597416496d74fd8bb0e961d84b1c3c1b2a3f4e79098f8046c2",
    "optionsSha256": "80af3370c638d2b89ab8e31a8e59a0341e0be346ecbea35a2da9e78ab3f240e3"
  }
]

export function createSubmittedSecretApprovalAuthorization({ connectionId, userId, expiresAt, readBearer, fetchImpl, now,
  createAuthorization = createOlrwAuthorization }) {
  if (typeof connectionId !== 'string' || !connectionId || typeof userId !== 'string' || !userId
    || !Number.isFinite(Date.parse(expiresAt)) || typeof readBearer !== 'function')
    throw new Error('SUBMITTED_SECRET_APPROVAL_UNAVAILABLE')
  const checks = expected.map(plan => createAuthorization({
    plan: { ...plan, connectionId, userId, expiresAt, actions: ['consume'] }, readBearer,
    ...(fetchImpl ? { fetchImpl } : {}), ...(now ? { now } : {}),
  }))
  return async () => { for (const check of checks) await check('consume') }
}
