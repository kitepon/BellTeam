import { createFixtureJobClient } from './fixtures/update-job-client.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createModuleUpdateExecutor } from '../src/update-module-executor.mjs'
import { createUpdateCenter } from '../src/update-center.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'
import { captureInstallInspectionOwner } from '../src/update-install-inspection.mjs'
import { installReconciliationHash as hash } from '../src/container-update-client.mjs'
import { EXECUTION_STATE_COMPATIBILITY } from '../src/execution-dispatcher.mjs'
import { createModuleExchangeMutex } from '../src/module-exchange-mutex.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'install-reconciliation-common-'))
  const path = join(root, 'state/update-ledger/ledger.json')
  const read = async () => JSON.parse(await readFile(path, 'utf8'))
  const shared = createModuleExchangeMutex()
  const calls = { starts: 0, inspections: 0, finalizes: 0, reads: 0, applies: 0, drains: 0 }
  let clock = Date.parse('2026-11-04T14:00:00Z'), available = true, owner = true, fence = null, lose = false
  let generation = 'builtin:actual-parent-generation'
  const release = { componentId: 'execution', sourceCommit: 'b'.repeat(40), versionId: 'c'.repeat(64),
    platform: { os: 'linux', arch: 'amd64' }, changes: [], artifact: { kind: 'archive' },
    compatibility: { nodeMajor: 26, parentProtocol: 1, stateSchema: null, containerUpdate: null, stateCompatibility: EXECUTION_STATE_COMPATIBILITY } }
  const selection = { catalogSha256: 'd'.repeat(64), expiresAt: '2099-01-01T00:00:00Z', release,
    publication: { status: 'verified' } }
  let installPlan
  const moduleHost = { ...createFixtureJobClient(root),
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
      assert.equal(available, true)
      assert.equal(saved.current.available, true)
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
    withInstallReconciliationProof: (component, operation) => shared.runExclusive(async () => {
      calls.drains++; available = false
      try { return await operation(() => true) } finally { available = true }
    }) }
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
    executor: () => executor, inspect, closeInput, normalDispatch: operation => shared.runExclusive(operation),
    close: () => executor.inspectModuleInstall(request.requestId, installId, closeInput(), grant()),
    async reload() { await executor.close(); executor = await createModuleUpdateExecutor(options) },
    lose: () => { lose = true }, revoke: () => { owner = false },
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

test('a lost close response survives reload and only reads its fence', async t => {
  const f = await fixture(t); await f.inspect(); f.lose()
  await assert.rejects(f.close(), { code: 'HOST_UPDATE_UNAVAILABLE' })
  assert.equal(f.executor().installReconciliation(f.request.requestId, f.installId).resolution.state, 'unknown')
  assert.throws(() => f.executor().reserveExchange(), { code: 'MODULE_EXCHANGE_BUSY' })
  await f.reload(); assert.equal((await f.close()).resolution.state, 'closed')
  assert.equal(f.calls.finalizes, 1); assert.equal(f.calls.reads, 1); assert.equal(f.calls.starts, 1)
})

test('forged grants and stale catalog cannot issue close', async t => {
  const f = await fixture(t)
  await assert.rejects(f.executor().inspectModuleInstall(f.request.requestId, f.installId, f.input, {}), { code: 'UPDATE_OWNER_REQUIRED' })
  await f.inspect()
  f.selection.publication.status = 'unconfirmed'
  await assert.rejects(f.close(), { code: 'UPDATE_RECONCILIATION_CATALOG_UNCONFIRMED' })
  f.revoke(); await assert.rejects(f.close(), { code: 'UPDATE_OWNER_REQUIRED' })
  assert.equal(f.calls.finalizes, 0)
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

test('close-only original-ID ownership and same-claim convergence', async t => {
  await t.test('paused finalize leaves normal dispatch mutex and availability free', async t => {
    const f = await fixture(t)
    await f.inspect()
    const entered = Promise.withResolvers(), resume = Promise.withResolvers()
    const finalize = f.moduleHost.finalizeInstallReconciliation
    f.moduleHost.finalizeInstallReconciliation = async input => {
      entered.resolve(); await resume.promise
      return finalize(input)
    }
    const input = f.closeInput(), closing = f.close()
    await entered.promise
    try {
      assert.equal(await f.normalDispatch(async () => f.options.adapters.execution.available()), true)
      assert.equal(f.calls.drains, 0)
      assert.throws(() => f.executor().reserveExchange(), { code: 'MODULE_EXCHANGE_BUSY' })
      await assert.rejects(f.executor().inspectModuleInstall(f.request.requestId, f.installId, input, f.grant()), { code: 'MODULE_EXCHANGE_BUSY' })
      await assert.rejects(f.executor().operation(f.request.requestId), { code: 'MODULE_EXCHANGE_BUSY' })
      await assert.rejects(f.executor().snapshot({ components: [] }), { code: 'MODULE_EXCHANGE_BUSY' })
    } finally { resume.resolve() }
    assert.equal((await closing).resolution.state, 'closed')
    assert.deepEqual(await f.executor().operation(f.request.requestId), f.original)
    const release = f.executor().reserveExchange(); release()
    assert.equal(f.calls.starts, 1); assert.equal(f.calls.applies, 0)
  })

  await t.test('unsafe original bindings refuse without suspending reception', async t => {
    for (const mode of ['applyIssued', 'hostIssued', 'original', 'claim']) {
      const f = await fixture(t); await f.inspect()
      if (mode === 'applyIssued' || mode === 'hostIssued') {
        const ledger = await f.read(), entry = ledger.operations[0]
        if (mode === 'applyIssued') entry.steps[0].applyIssued = true
        else entry.hostIssued = true
        await writeFile(f.path, JSON.stringify(ledger)); await f.reload()
        await assert.rejects(f.close(), { code: 'UPDATE_RECONCILIATION_APPLY_UNCONFIRMED' })
      } else if (mode === 'original') {
        await assert.rejects(f.executor().inspectModuleInstall(f.request.requestId, f.installId,
          { ...f.closeInput(), originalOperationSha256: 'f'.repeat(64) }, f.grant()), { code: 'UPDATE_RECONCILIATION_ORIGINAL_CHANGED' })
      } else {
        f.lose(); await assert.rejects(f.close(), { code: 'HOST_UPDATE_UNAVAILABLE' })
        await assert.rejects(f.executor().inspectModuleInstall(f.request.requestId, f.installId,
          { ...f.closeInput(), inspectionSha256: 'f'.repeat(64) }, f.grant()), { code: 'UPDATE_RECONCILIATION_REQUEST_CONFLICT' })
        assert.equal(f.calls.finalizes, 1); assert.equal(f.calls.reads, 0)
      }
      assert.equal(await f.normalDispatch(async () => f.options.adapters.execution.available()), true)
      assert.equal(f.calls.drains, 0); assert.equal(f.calls.applies, 0)
    }
  })

  await t.test('mutating job read owns the ledger before it awaits', async t => {
    const f = await fixture(t); await f.inspect()
    const ledger = await f.read(), entry = ledger.operations[0]
    entry.steps[0].jobReport = { state: 'failed', reason: { code: 'UPDATE_PARENT_INTERRUPTED', message: 'interrupted' } }
    entry.interrupted = true
    await writeFile(f.path, JSON.stringify(ledger)); await f.reload()
    const input = f.closeInput(), entered = Promise.withResolvers(), resume = Promise.withResolvers()
    const job = f.moduleHost.job; let first = true
    f.moduleHost.job = async id => {
      if (first) { first = false; entered.resolve(); await resume.promise }
      return job(id)
    }
    const reading = f.executor().operation(f.request.requestId)
    await entered.promise
    try {
      await assert.rejects(f.executor().inspectModuleInstall(f.request.requestId, f.installId, input, f.grant()), { code: 'MODULE_EXCHANGE_BUSY' })
      assert.equal(f.calls.finalizes, 0)
    } finally { resume.resolve() }
    await reading
    const saved = (await f.read()).operations[0]
    assert.equal(saved.interrupted, false)
    assert.equal(saved.steps[0].jobReport, undefined)
    assert.equal((await f.close()).resolution.state, 'closed')
  })

  await t.test('retained close cannot readmit work or flush late reports', async t => {
    const f = await fixture(t); await f.inspect(); await f.close()
    const ledger = await f.read(), entry = ledger.operations[0]
    entry.admissionComplete = false; entry.interrupted = true
    entry.steps[0].jobReport = { state: 'ready', reason: null }
    await writeFile(f.path, JSON.stringify(ledger)); await f.reload()
    const before = await readFile(f.path, 'utf8'), calls = { ...f.calls }
    assert.deepEqual(await f.executor().start(f.request), f.original)
    assert.deepEqual(await f.executor().operation(f.request.requestId), f.original)
    await f.executor().snapshot({ components: [], notice: { code: 'UPDATE_PROVIDERS_UNAVAILABLE' } })
    assert.equal(await readFile(f.path, 'utf8'), before)
    assert.deepEqual(f.calls, calls)
  })

  await t.test('current change after runtime fence retains the claim and only converges', async t => {
    const f = await fixture(t); await f.inspect()
    const finalize = f.moduleHost.finalizeInstallReconciliation
    f.moduleHost.finalizeInstallReconciliation = async input => {
      const fence = await finalize(input); f.changeGeneration(); return fence
    }
    await assert.rejects(f.close(), { code: 'UPDATE_RECONCILIATION_PROOF_CHANGED' })
    assert.equal(f.executor().installReconciliation(f.request.requestId, f.installId).resolution.state, 'unknown')
    assert.throws(() => f.executor().reserveExchange(), { code: 'MODULE_EXCHANGE_BUSY' })
    assert.equal((await f.close()).resolution.state, 'closed')
    assert.equal(f.calls.finalizes, 1); assert.equal(f.calls.reads, 1)
    assert.equal(f.calls.drains, 0)
  })

  await t.test('post-fence save uncertainty reloads and reads the same fence only', async t => {
    const f = await fixture(t); await f.inspect()
    const finalize = f.moduleHost.finalizeInstallReconciliation
    let durable
    f.moduleHost.finalizeInstallReconciliation = async input => {
      const fence = await finalize(input)
      durable = await readFile(f.path, 'utf8')
      await rm(f.path); await mkdir(f.path)
      return fence
    }
    await assert.rejects(f.close(), { code: 'UPDATE_LEDGER_WRITE_FAILED' })
    assert.equal(f.executor().installReconciliation(f.request.requestId, f.installId).resolution.state, 'unknown')
    assert.throws(() => f.executor().reserveExchange(), { code: 'UPDATE_LEDGER_WRITE_FAILED' })
    assert.equal((await f.executor().operation(f.request.requestId)).phase, 'unknown')
    await rm(f.path, { recursive: true }); await writeFile(f.path, durable, { mode: 0o600 })
    await f.reload()
    assert.equal((await f.close()).resolution.state, 'closed')
    assert.equal(f.calls.finalizes, 1); assert.equal(f.calls.reads, 1)
    assert.equal(f.calls.starts, 1); assert.equal(f.calls.applies, 0)
  })
})
