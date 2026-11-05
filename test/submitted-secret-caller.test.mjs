import test from 'node:test'
import assert from 'node:assert/strict'
import { createSubmittedSecretCaller, SUBMITTED_SECRET as plan } from '../src/submitted-secret-caller.mjs'
const request = bot => ({ headers: { 'x-bellteam-seat': bot } })
const item = () => ({ id: plan.requestId, botId: plan.requesterBotId, roomId: null, toolId: plan.toolId, status: 'submitted' })
function fixture() {
  let row = item(), enabled = true, owner = true, failedCompletion = false, executed = 0, ownerChecks = 0, closeDone
  const tokens = [], seen = [], pendingClose = new Promise(resolve => { closeDone = resolve })
  const usageAssembly = {
    capture(method, actor) { const token = { method, actor }; tokens.push(token); return token },
    systemContext(method) { const token = { method, actor: { kind: 'system' } }; tokens.push(token); return token },
  }
  const caller = createSubmittedSecretCaller({ root: '/own', bots: { async readMember(id) { return { id } } }, usageAssembly,
    aiControl: { admit() { return () => { if (!enabled) throw Error('PAUSED') } } },
    secretRequests: { toolsDirectory: '/own/state/secret-values', read(id, token) {
      assert.equal(id, plan.requestId); assert.ok(tokens.includes(token)); seen.push(token.actor.kind)
      const result = Promise.resolve({ ...row }); result.completion = failedCompletion ? Promise.resolve().then(() => { throw Error('REAL_COMPLETION_FAILED') }) : result
      return result
    } },
    async assertOwnerAuthorized(fixed) { ownerChecks++; assert.equal(fixed, plan); if (!owner) throw Error('OWNER_REVOKED') },
    createConsumer(config) { return { config, async execute(admission) { await config.assertAuthorized(admission); await config.secretRequests.read(plan.requestId); executed++; return 'issued' }, close: () => pendingClose } },
    consume() { throw Error('NO_REAL_CONSUMPTION') },
  })
  return { caller, tokens, seen, setRow(v) { row = v }, pause() { enabled = false }, revoke() { owner = false }, failCompletion() { failedCompletion = true }, get executed() { return executed }, get ownerChecks() { return ownerChecks }, closeDone }
}
test('same seat and Owner authorization precede opaque grant; each system read is fresh', async () => {
  const f = fixture(), grant = await f.caller.capture(request(plan.requesterBotId), plan.requestId)
  assert.deepEqual(grant, {}); assert.ok(Object.isFrozen(grant)); assert.equal(await f.caller.consumer.execute(grant), 'issued'); await f.caller.consumer.config.secretRequests.read(plan.requestId)
  assert.deepEqual(f.seen, ['bot', 'bot', 'system', 'system']); assert.equal(new Set(f.tokens).size, 4); assert.equal(f.ownerChecks, 2)
})
test('different seat, request, owner, tool or status cannot capture', async () => {
  const f = fixture(); await assert.rejects(f.caller.capture(request('other'), plan.requestId)); await assert.rejects(f.caller.capture(request(plan.requesterBotId), 'other'))
  for (const patch of [{ botId: 'other' }, { toolId: 'other' }, { status: 'pending' }]) { f.setRow({ ...item(), ...patch }); await assert.rejects(f.caller.capture(request(plan.requesterBotId), plan.requestId)) }
  assert.equal(f.executed, 0)
})
test('serializable admission never authorizes consumption', async () => {
  const f = fixture(); await assert.rejects(f.caller.consumer.execute({})); await assert.rejects(f.caller.consumer.execute(JSON.parse(JSON.stringify(await f.caller.capture(request(plan.requesterBotId), plan.requestId))))); assert.equal(f.executed, 0)
})
test('late metadata completion failure prevents grant and Owner check', async () => {
  const f = fixture(); f.failCompletion(); await assert.rejects(f.caller.capture(request(plan.requesterBotId), plan.requestId), /REAL_COMPLETION_FAILED/); assert.equal(f.executed, 0); assert.equal(f.ownerChecks, 0)
})
test('Owner revocation and original AI admission invalidation reject before effect', async () => {
  for (const change of ['pause', 'revoke']) { const f = fixture(), g = await f.caller.capture(request(plan.requesterBotId), plan.requestId); f[change](); await assert.rejects(f.caller.consumer.execute(g)); assert.equal(f.executed, 0) }
})
test('close invalidates grants immediately and waits actual consumer close', async () => {
  const f = fixture(), g = await f.caller.capture(request(plan.requesterBotId), plan.requestId); let done = false; const closing = f.caller.close().then(() => { done = true }); await Promise.resolve(); assert.equal(done, false); await assert.rejects(f.caller.consumer.execute(g)); f.closeDone(); await closing; assert.equal(done, true)
})
