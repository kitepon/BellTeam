import assert from 'node:assert/strict'
import test from 'node:test'
import { MembersAdmission } from '../src/members-admission.mjs'

// a505b (production 11/22 09:59): 87 seats launched at once and the 23 past 64 leases were refused.
// A lease counts nothing; the IPC root queue is what bounds concurrent roots.
test('a505b: more than 64 members leases enter at once and all finish', () => {
  const admission = new MembersAdmission(), leases = Array.from({ length: 200 }, () => admission.enter())
  assert.equal(new Set(leases).size, 200)
  for (const lease of leases) admission.finish(lease)
  return admission.drain(admission.close())
})
