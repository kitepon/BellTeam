import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyRegisteredSubmittedSecretApproval } from '../src/submitted-secret-approval-owner.mjs'
import { createSubmittedSecretApprovalBridge } from '../src/submitted-secret-approval-bridge.mjs'
test('only the adopted registered identity and original credential capability reach the verifier', async () => {
  const config = { server: 'https://approval-box.kitepon.dev', token: 'synthetic-credential' }; let checks = 0
  await verifyRegisteredSubmittedSecretApproval({ readConfig: async () => config, now: () => 0,
    createAuthorization(options) { assert.equal(options.connectionId, '98867faa-dcef-4262-b961-598d1622c8f7'); assert.equal(options.userId, '2f11a5ad-8439-4006-91c4-ea8fd1c3a057'); assert.equal(options.expiresAt, '1970-01-01T00:01:00.000Z'); return async () => { assert.equal(await options.readBearer(), 'synthetic-credential'); checks++ } },
  })
  assert.equal(checks, 1); assert.equal(config.token, null)
})
test('foreign server or malformed credential fails before authorization', async () => {
  for (const config of [{ server: 'https://other', token: 'synthetic' }, { server: 'https://approval-box.kitepon.dev', token: 'bad\ntoken' }]) {
    await assert.rejects(verifyRegisteredSubmittedSecretApproval({ readConfig: async () => config, createAuthorization() { assert.fail('MUST_NOT_AUTHORIZE') } }), /UNAVAILABLE/)
  }
})
test('fixed base-runner verifier returns only the closed affirmative result', async () => {
  let calls = 0
  const check = createSubmittedSecretApprovalBridge({ project: '/own', run: async (command, args, options) => {
    assert.equal(command, process.execPath); assert.equal(args.length, 1); assert.ok(args[0].endsWith('/scripts/verify-submitted-secret-approval.mjs')); assert.equal(options.maxBuffer, 4096); assert.equal(options.input, undefined); calls++
    return { stdout: JSON.stringify({ schema: 'bellteam.submitted-secret-approval.v1', authorized: true }), stderr: '' }
  } })
  await check(); assert.equal(calls, 1)
})
test('denial, unknown, extra output or stderr cannot become a grant or expose raw output', async () => {
  for (const result of [{ stdout: '{"schema":"bellteam.submitted-secret-approval.v1","authorized":false}', stderr: '' }, { stdout: '{"schema":"bellteam.submitted-secret-approval.v1","authorized":true,"extra":"sensitive"}', stderr: '' }, { stdout: 'sensitive', stderr: '' }, { stdout: '{}', stderr: 'sensitive' }]) {
    const check = createSubmittedSecretApprovalBridge({ project: '/own', run: async () => result })
    await assert.rejects(check(), error => error.message === 'SUBMITTED_SECRET_APPROVAL_UNAVAILABLE')
  }
})
