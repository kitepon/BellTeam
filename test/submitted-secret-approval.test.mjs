import test from 'node:test'
import assert from 'node:assert/strict'
import { createSubmittedSecretApprovalAuthorization } from '../src/submitted-secret-approval.mjs'
const base = { connectionId: 'original-connection', userId: 'original-owner', expiresAt: '2026-11-05T05:00:00Z', readBearer: async () => 'synthetic' }
test('both original decisions retain exact original context/options expectations on every authorization', async () => {
  const plans = [], calls = []
  const check = createSubmittedSecretApprovalAuthorization({ ...base, createAuthorization({ plan }) { plans.push(plan); return async action => { calls.push([plan.decisionId, action]) } } })
  await check(); await check()
  assert.deepEqual(plans.map(p => [p.decisionId, p.version, p.optionId, p.requester]), [['K-3JM9PS', 3, 'start_now', 'トロニー'], ['K-6782UM', 3, 'entered_secret', 'センチ']])
  assert.equal(plans[0].contextSha256, '460d16ba1332d73f42dbe0fbda1f1f19f0101e41da3572b7754711e7ec65ae75')
  assert.equal(plans[1].contextSha256, '91946b929c7700597416496d74fd8bb0e961d84b1c3c1b2a3f4e79098f8046c2')
  assert.deepEqual(calls.map(c => c[0]), ['K-3JM9PS', 'K-6782UM', 'K-3JM9PS', 'K-6782UM'])
})
test('no existing managed identity or credential capability fails closed', () => {
  for (const patch of [{ connectionId: null }, { userId: null }, { expiresAt: null }, { readBearer: null }]) assert.throws(() => createSubmittedSecretApprovalAuthorization({ ...base, ...patch }), /UNAVAILABLE/)
})
test('first original approval rejection stops before second check', async () => {
  let calls = 0
  const check = createSubmittedSecretApprovalAuthorization({ ...base, createAuthorization() { return async () => { calls++; throw Error('REVOKED') } } })
  await assert.rejects(check(), /REVOKED/); assert.equal(calls, 1)
})
