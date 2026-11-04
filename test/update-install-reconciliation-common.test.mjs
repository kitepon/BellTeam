import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter, once } from 'node:events'
import { createModuleUpdateExecutor } from '../src/update-module-executor.mjs'
import { createUpdateCenter } from '../src/update-center.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'
import { captureInstallInspectionOwner, createInstallReconciliationProof } from '../src/update-install-inspection.mjs'
import { installReconciliationHash as hash } from '../src/container-update-client.mjs'
import { EXECUTION_STATE_COMPATIBILITY } from '../src/execution-dispatcher.mjs'
import { createModuleExchangeMutex } from '../src/module-exchange-mutex.mjs'
import { createExecutionGeneration } from '../src/execution-generation.mjs'
import { createExecutionDispatcher } from '../src/execution-dispatcher.mjs'
import { createModuleProcess } from '../src/module-process.mjs'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'

async function fixture(t, { missingProof = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'install-reconciliation-common-'))
  const path = join(root, 'state/update-ledger/ledger.json')
  const read = async () => JSON.parse(await readFile(path, 'utf8'))
  const calls = { starts: 0, inspections: 0, finalizes: 0, reads: 0, applies: 0 }
  let clock = Date.parse('2026-11-04T14:00:00Z'), available = true, owner = true, proof = true, fence = null, lose = false
  let generation = 'builtin:actual-parent-generation'
  const release = { componentId: 'execution', sourceCommit: 'b'.repeat(40), versionId: 'c'.repeat(64),
    platform: { os: 'linux', arch: 'amd64' }, changes: [], artifact: { kind: 'archive' },
    compatibility: { nodeMajor: 26, parentProtocol: 1, stateSchema: null, containerUpdate: null, stateCompatibility: EXECUTION_STATE_COMPATIBILITY } }
  const selection = { catalogSha256: 'd'.repeat(64), expiresAt: '2099-01-01T00:00:00Z', release,
    publication: { status: 'verified' } }
  let installPlan
  const moduleHost = {
    moduleInstallCapabilities: async () => ({ supported: true }),
    planModuleInstall: async input => (installPlan = { schema: 'bellteam.host-update.plan.v1', ...input, target: release,
      expiresAt: '2099-01-01T00:00:00Z', impact: { containerRestart: false } }),
    async startModuleInstall(input) { calls.starts++; return this.operation(input.requestId) },
    async operation(requestId) { return { requestId, planId: installPlan.planId, target: release, admission: 'accepted',
      phase: 'unknown', execution: 'unknown', verification: 'unknown' } },
    async inspectModuleInstall(input) {
      calls.inspections++
      const receipt = { schema: 'bellteam.module-install-inspection.v1', requestId: input.requestId,
        planId: installPlan.planId, componentId: 'execution', versionId: release.versionId, sourceCommit: release.sourceCommit,
        originalOperationSha256: input.originalOperationSha256, planSha256: '1'.repeat(64), targetSha256: hash(release),
        storageBindingSha256: '2'.repeat(64), runtimeCurrentSha256: '3'.repeat(64), inspectionTime: new Date(clock).toISOString(),
        placement: 'absent', quiescence: 'confirmed', stageState: 'clear', manifestSha256: null,
        recoveryState: 'not_issued', fence: 'open', evidenceSha256: '4'.repeat(64), reason: null }
      return { receiptSha256: hash(receipt), receipt }
    },
    async finalizeInstallReconciliation(input) {
      calls.finalizes++
      const saved = (await read()).operations[0].steps[0].installReconciliation.close
      assert.deepEqual(saved.decision, input.decision)
      assert.deepEqual(saved.commonProof, input.commonProof)
      assert.equal(saved.fence, null)
      assert.equal(available, false)
      assert.equal(saved.current.available, false)
      const value = { schema: 'bellteam.module-install-fence.v1', requestId: input.requestId, planId: installPlan.planId,
        originalOperationSha256: input.originalOperationSha256, decisionSha256: input.decision.decisionSha256,
        commonProofSha256: input.commonProof.proofSha256, action: 'close_without_activation', closedAt: new Date(clock).toISOString() }
      fence = { fenceSha256: hash(value), fence: value }
      if (lose) throw Object.assign(new Error('lost response'), { code: 'HOST_UPDATE_UNAVAILABLE', status: 503 })
      return structuredClone(fence)
    },
    async readInstallReconciliationFence() { calls.reads++; return structuredClone(fence) },
  }
  const options = { root, moduleHost, catalog: { select: async () => selection }, now: () => clock,
    adapters: { execution: { current: () => ({ version: 'a'.repeat(40), sourceCommit: 'a'.repeat(40), digest: null, origin: 'builtin' }),
      capture: () => ({ generation, pid: null }), available: () => available, canRollback: () => true,
      async prepare() { throw Object.assign(new Error(), { code: 'ENOENT' }) }, async apply() { calls.applies++ } } },
    withInstallReconciliationProof: missingProof ? null : async (component, operation) => {
      assert.equal(component, 'execution'); available = false
      try { return await operation(() => proof) } finally { available = true }
    } }
  let executor = await createModuleUpdateExecutor(options)
  t.after(async () => { await executor.close(); await rm(root, { recursive: true, force: true }) })
  const plan = await executor.plan({ scope: 'component', componentId: 'execution' })
  const request = { planId: plan.planId, requestId: randomUUID(), confirmContainerRestart: false }
  await executor.start(request)
  for (let n = 0; n < 100; n++) {
    if ((await executor.operation(request.requestId)).phase === 'unknown') break
    await new Promise(resolve => setImmediate(resolve))
  }
  const original = await executor.operation(request.requestId), saved = await read(), installId = saved.operations[0].steps[0].installRequestId
  assert.equal(original.phase, 'unknown')
  await executor.close(); executor = await createModuleUpdateExecutor(options)
  const input = { action: 'inspect', originalOperationSha256: 'e'.repeat(64) }
  const grant = () => captureInstallInspectionOwner(async () => owner)
  const inspect = () => executor.inspectModuleInstall(request.requestId, installId, input, grant())
  const closeInput = () => ({ action: 'close_without_activation', originalOperationSha256: input.originalOperationSha256,
    inspectionSha256: executor.installReconciliation(request.requestId, installId).inspection.receiptSha256 })
  return { root, path, read, calls, options, moduleHost, original, request, installId, grant, input, selection,
    executor: () => executor, inspect, closeInput,
    close: () => executor.inspectModuleInstall(request.requestId, installId, closeInput(), grant()),
    async reload() { await executor.close(); executor = await createModuleUpdateExecutor(options) },
    lose: () => { lose = true }, revoke: () => { owner = false }, unconfirm: () => { proof = false },
    changeGeneration: () => { generation = 'different-instance' }, advance: () => { clock += 600001 } }
}

test('inspection HTTP is Owner-only, closed, and GET only projects saved state', async t => {
  const f = await fixture(t), center = createUpdateCenter({ moduleExecutor: f.executor() })
  const server = createBellTeamServer({ bots: { refresh() { assert.fail('refresh') } }, authorize: req => req.headers.authorization === 'owner',
    messenger: {}, store: {}, transport: {}, updateCenter: center, writeLog() {} })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const url = `http://127.0.0.1:${server.address().port}/api/updates/operations/${f.request.requestId}/reconciliation/${f.installId}`
  const headers = { authorization: 'owner', 'content-type': 'application/json' }
  assert.equal((await fetch(url)).status, 403)
  assert.equal((await fetch(url, { headers })).status, 200)
  assert.equal(f.calls.inspections, 0)
  assert.equal((await fetch(url, { headers, method: 'POST', body: JSON.stringify({ ...f.input, target: 'untrusted' }) })).status, 400)
  const response = await fetch(url, { headers, method: 'POST', body: JSON.stringify(f.input) })
  assert.equal(response.status, 200)
  const value = await response.json()
  assert.equal(value.reconciliation.inspection.placement, 'absent')
  assert.equal(JSON.stringify(value).includes('storageBinding'), false)
  const before = { ...f.calls }
  assert.deepEqual(await (await fetch(url, { headers })).json(), value)
  assert.deepEqual(f.calls, before)
  await assert.rejects(f.executor().plan({ scope: 'component', componentId: 'execution' }), { code: 'MODULE_EXCHANGE_BUSY' })
})

test('same-ID close persists proof before RPC and fence before excluding busy, keeping original unknown', async t => {
  const f = await fixture(t)
  await f.inspect(); assert.equal((await f.close()).resolution.state, 'closed')
  assert.deepEqual(await f.executor().operation(f.request.requestId), f.original)
  assert.equal((await f.read()).operations[0].steps[0].installPhase, 'unknown')
  const release = f.executor().reserveExchange(); release()
  await f.reload()
  assert.equal(f.executor().installReconciliation(f.request.requestId, f.installId).resolution.state, 'closed')
  assert.deepEqual(await f.executor().start(f.request), f.original)
  assert.equal((await f.close()).resolution.state, 'closed')
  assert.equal(f.calls.finalizes, 1); assert.equal(f.calls.starts, 1); assert.equal(f.calls.applies, 0)
  const ledger = await f.read(), clone = structuredClone(ledger.operations[0])
  clone.operation.requestId = randomUUID(); clone.operation.reference = clone.operation.requestId
  clone.steps[0].installRequestId = randomUUID(); delete clone.steps[0].installReconciliation
  ledger.operations.push(clone); await writeFile(f.path, JSON.stringify(ledger))
  await f.reload()
  assert.throws(() => f.executor().reserveExchange(), { code: 'MODULE_EXCHANGE_BUSY' })
})

test('a lost close response survives reload and only reads its fence, even without a live proof provider', async t => {
  const f = await fixture(t); await f.inspect(); f.lose()
  await assert.rejects(f.close(), { code: 'HOST_UPDATE_UNAVAILABLE' })
  assert.equal(f.executor().installReconciliation(f.request.requestId, f.installId).resolution.state, 'unknown')
  assert.throws(() => f.executor().reserveExchange(), { code: 'MODULE_EXCHANGE_BUSY' })
  f.options.withInstallReconciliationProof = null
  await f.reload(); assert.equal((await f.close()).resolution.state, 'closed')
  assert.equal(f.calls.finalizes, 1); assert.equal(f.calls.reads, 1); assert.equal(f.calls.starts, 1)
})

test('forged grants, missing proof, stale catalog, and unconfirmed live proof cannot issue close', async t => {
  const f = await fixture(t, { missingProof: true })
  await assert.rejects(f.executor().inspectModuleInstall(f.request.requestId, f.installId, f.input, {}), { code: 'UPDATE_OWNER_REQUIRED' })
  await f.inspect(); await assert.rejects(f.close(), { code: 'UPDATE_RECONCILIATION_PROOF_UNAVAILABLE' })
  const g = await fixture(t); await g.inspect(); g.unconfirm()
  await assert.rejects(g.close(), { code: 'UPDATE_RECONCILIATION_PROOF_CHANGED' })
  g.selection.publication.status = 'unconfirmed'
  await assert.rejects(g.close(), { code: 'UPDATE_RECONCILIATION_CATALOG_UNCONFIRMED' })
  g.revoke(); await assert.rejects(g.close(), { code: 'UPDATE_OWNER_REQUIRED' })
  assert.equal(f.calls.finalizes + g.calls.finalizes, 0)
})

test('revocation after the durable claim keeps busy and never reissues, and changed saved fence is refused', async t => {
  const f = await fixture(t); await f.inspect()
  const select = f.options.catalog.select; let reads = 0
  f.options.catalog.select = async (...args) => { const value = await select(...args); if (++reads === 3) f.revoke(); return value }
  await assert.rejects(f.close(), { code: 'UPDATE_OWNER_REQUIRED' })
  assert.equal(f.calls.finalizes, 0)
  assert.equal(f.executor().installReconciliation(f.request.requestId, f.installId).resolution.state, 'unknown')
  assert.throws(() => f.executor().reserveExchange(), { code: 'MODULE_EXCHANGE_BUSY' })
  const g = await fixture(t); await g.inspect(); await g.close(); await g.executor().close()
  const ledger = await g.read(), fence = ledger.operations[0].steps[0].installReconciliation.close.fence
  fence.fence.commonProofSha256 = 'f'.repeat(64); fence.fenceSha256 = hash(fence.fence)
  await writeFile(g.path, JSON.stringify(ledger))
  await assert.rejects(createModuleUpdateExecutor(g.options), { code: 'UPDATE_LEDGER_INVALID' })
})

test('expiry and parent close after the durable claim block the issuing call', async t => {
  for (const mode of ['expired', 'parent_close']) {
    const f = await fixture(t); await f.inspect()
    const select = f.options.catalog.select; let reads = 0, closing
    f.options.catalog.select = async (...args) => {
      const value = await select(...args)
      if (++reads === 3) { if (mode === 'expired') f.advance(); else closing = f.executor().close() }
      return value
    }
    await assert.rejects(f.close(), { code: 'UPDATE_RECONCILIATION_PROOF_CHANGED' })
    await closing
    assert.equal(f.calls.finalizes, 0)
    assert.equal((await f.read()).operations[0].steps[0].installReconciliation.close.fence, null)
  }
})

test('fresh Owner revocation during fence read cannot complete or unblock the claim', async t => {
  const f = await fixture(t); await f.inspect(); f.lose()
  await assert.rejects(f.close(), { code: 'HOST_UPDATE_UNAVAILABLE' })
  const read = f.moduleHost.readInstallReconciliationFence
  f.moduleHost.readInstallReconciliationFence = async (...args) => { const value = await read(...args); f.revoke(); return value }
  await assert.rejects(f.close(), { code: 'UPDATE_OWNER_REQUIRED' })
  assert.throws(() => f.executor().reserveExchange(), { code: 'MODULE_EXCHANGE_BUSY' })
  assert.equal(f.calls.finalizes, 1); assert.equal(f.calls.reads, 1)
})

test('the composed private provider holds the shared mutex once and both live assertions for full completion', async () => {
  const mutex = createModuleExchangeMutex(), completion = Promise.withResolvers(), entered = Promise.withResolvers(), order = []
  let held = null
  const provider = name => ({ async withInstallReconciliationProof(operation) {
    let valid = true; order.push(name + ':hold')
    const assertHeld = () => { assert(valid); return true }
    try { return await operation(assertHeld) } finally { valid = false; order.push(name + ':resume') }
  } })
  const run = createInstallReconciliationProof({ execution: provider('engine'), conversation: provider('writer'), exchangeMutex: mutex })
  const attempt = run('execution', check => {
    held = check; assert.equal(check(), true); entered.resolve()
    return Object.assign(Promise.resolve('saved'), { completion: completion.promise })
  })
  await entered.promise
  assert.throws(() => mutex.reserve(), { code: 'MODULE_EXCHANGE_BUSY' })
  assert.deepEqual(order, ['engine:hold', 'writer:hold']); assert.equal(held(), true)
  completion.resolve(); assert.equal(await attempt, 'saved')
  assert.deepEqual(order, ['engine:hold', 'writer:hold', 'writer:resume', 'engine:resume'])
  assert.throws(held)
})

test('real engine and writer providers compose without reacquiring their shared mutex', async t => {
  const root = await mkdtemp(join(tmpdir(), 'install-proof-composition-')); await mkdir(join(root, 'state'))
  const mutex = createModuleExchangeMutex(), admission = new ConversationLifetimes(), resume = [], done = Promise.withResolvers(), entered = Promise.withResolvers()
  const execution = createExecutionGeneration({ exchangeMutex: mutex, onAdopt: async () => {},
    ports: { bots: new Map(), rooms: {}, configurationStorage: { root: join(root, 'intents'), ownerUid: process.getuid() },
      membersAdmission: new MembersAdmission(), access: { assertWorkAllowed() {} }, observer: { report() {} },
      native: { async call() { return {} }, async close() { assert.fail('shared native close') } } },
    loadFactory: async versionId => Object.freeze({ versionId, sourceCommit: 'a'.repeat(40), createExecutionDispatcher }) })
  const end = child => {
    child.exitCode = 0; child.connected = false; child.stdout.closed = child.stderr.closed = true
    child.stdout.emit('close'); child.stderr.emit('close'); child.emit('exit', 0, null); child.emit('close', 0, null)
  }
  const conversation = createModuleProcess({ component: 'conversation', root, admission, exchangeMutex: mutex,
    prepareRelease: async () => {}, validateReady() {}, spawnProcess: () => {
      const child = Object.assign(new EventEmitter(), { connected: true, exitCode: null, signalCode: null,
        stdout: Object.assign(new EventEmitter(), { closed: false, resume() {} }),
        stderr: Object.assign(new EventEmitter(), { closed: false, resume() {} }) })
      child.disconnect = () => end(child); child.kill = () => { end(child); return true }; return child
    }, createChannel: child => ({ ready: Promise.resolve({ versionId: null, protocolVersion: 1 }),
      control(method) {
        if (method === 'exit') queueMicrotask(() => end(child))
        if (method === 'resume') resume.push(method)
        return Promise.resolve({ resumed: true, quiesced: true })
      }, request: async () => null, callback: async () => null, drainIncoming: async () => {}, reaped: async () => {} }) })
  t.after(async () => { done.resolve(); await conversation.close(); await execution.close(); await rm(root, { recursive: true, force: true }) })
  await execution.start(); await conversation.start()
  const run = createInstallReconciliationProof({ execution, conversation, exchangeMutex: mutex })
  let held, callbacks = 0
  const attempt = run('execution', check => {
    callbacks++; held = check; assert.equal(check(), true); entered.resolve()
    return Object.assign(Promise.resolve('fence persisted'), { completion: done.promise })
  })
  await entered.promise
  assert.equal(callbacks, 1); assert.equal(execution.snapshot().available, false); assert.equal(conversation.snapshot().available, false)
  assert.throws(() => mutex.reserve(), { code: 'MODULE_EXCHANGE_BUSY' })
  await assert.rejects(execution.dispatch({ method: 'transport.observe', args: [{}] }), { code: 'EXECUTION_NOT_ACCEPTING' })
  assert.throws(() => admission.enter())
  done.resolve(); assert.equal(await attempt, 'fence persisted')
  assert.equal(execution.snapshot().available, true); assert.equal(conversation.snapshot().available, true)
  assert.throws(held); assert.equal(resume.length, 2)
})
