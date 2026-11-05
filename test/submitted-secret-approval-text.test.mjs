import test from 'node:test'
import assert from 'node:assert/strict'
import { createSubmittedSecretApprovalAuthorization } from '../src/submitted-secret-approval.mjs'
const original = '認証こっちに回してくれればやるよ'
const answer = { text: original, answered_at: '2026-11-05T03:12:22.959Z' }
function checkWith(first, inspect) {
  return createSubmittedSecretApprovalAuthorization({ connectionId: 'connection', userId: 'owner', expiresAt: '2026-11-05T05:00:00Z', readBearer: async () => 'synthetic',
    fetchImpl: async url => new Response(JSON.stringify(url.endsWith('K-3JM9PS') ? first : { answer: { text: 'must remain rejected by the existing validator' } })),
    createAuthorization: ({ plan, fetchImpl }) => async () => {
      const value = await (await fetchImpl('https://approval-box.kitepon.dev/connector/v1/decisions/' + plan.decisionId, {})).json()
      inspect(plan.decisionId, value)
    },
  })
}
test('only the fixed original text and answer timestamp are projected; other card is untouched', async () => {
  const seen = []
  await checkWith({ answer }, (id, value) => seen.push([id, value.answer.text]))()
  assert.deepEqual(seen, [['K-3JM9PS', null], ['K-6782UM', 'must remain rejected by the existing validator']])
})
test('changed text, absent text, timestamp drift and over-limit response fail before a grant', async () => {
  for (const value of [{ answer: { ...answer, text: original + ' ' } }, { answer: { ...answer, text: 'x'.repeat(48) } }, { answer: {} }, { answer: { ...answer, answered_at: '2026-11-05T03:12:22.960Z' } }, { answer, extra: 'x'.repeat(65536) }]) {
    await assert.rejects(checkWith(value, () => assert.fail('MUST_NOT_AUTHORIZE'))(), /UNAVAILABLE/)
  }
})
