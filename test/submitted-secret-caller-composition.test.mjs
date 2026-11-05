import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createSubmittedSecretCaller, SUBMITTED_SECRET as plan } from '../src/submitted-secret-caller.mjs'
import { createSubmittedSecretConsumer } from '../src/usage/submitted-secret-consumer.mjs'
test('fixed parent grant joins real consumer metadata, durable claim and one synthetic consume', async t => {
  const root = await mkdtemp(join(process.cwd(), '.submitted-composition-')); t.after(() => rm(root, { recursive: true, force: true }))
  const toolsDirectory = join(root, 'state/secret-values'), directory = join(toolsDirectory, plan.toolId, 'secrets')
  await mkdir(directory, { recursive: true, mode: 0o700 }); const path = join(directory, plan.requestId); await writeFile(path, 'synthetic-code', { mode: 0o600 })
  const tokenActors = new WeakMap(); let consumes = 0, ownerChecks = 0
  const caller = createSubmittedSecretCaller({ root, bots: { async readMember(id) { return { id } } }, aiControl: { admit: () => () => {} },
    usageAssembly: { capture(_method, actor) { const token = {}; tokenActors.set(token, actor.kind); return token }, systemContext() { const token = {}; tokenActors.set(token, 'system'); return token } },
    secretRequests: { toolsDirectory, read(id, token) { assert.ok(tokenActors.has(token)); return Promise.resolve({ id, botId: plan.requesterBotId, toolId: plan.toolId, roomId: null, status: 'submitted', path }) } },
    async assertOwnerAuthorized() { ownerChecks++ }, createConsumer: createSubmittedSecretConsumer,
    async consume(payload) { consumes++; assert.equal(payload.response.value, 'synthetic-code'); return { schema: 'bellteam.submitted-secret-input.v1', outcome: 'issued', authStatus: 'authenticated', httpStatus: 200 } },
  })
  const admission = await caller.capture({ headers: { 'x-bellteam-seat': plan.requesterBotId } }, plan.requestId)
  const challenge = { binding: { session_id: 'synthetic-session', launch_id: null, metadata_identity: 'synthetic-metadata', native_id: 'native', pane_id: 'pane', server_pid: 10, server_started: '1', pane_pid: 11, pane_started: '2' }, prompt_digest: 'a'.repeat(64) }
  const receipt = await caller.consumer.execute({ requestId: plan.requestId, challenge, admission })
  assert.equal(receipt.outcome, 'issued'); assert.equal(consumes, 1); assert.ok(ownerChecks >= 4); assert.ok(!JSON.stringify(receipt).includes('synthetic'))
  await caller.close()
})
