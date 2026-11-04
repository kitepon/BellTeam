import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModuleUpdateExecutor } from '../src/update-module-executor.mjs'
import { USAGE_STATE_COMPATIBILITY } from '../src/usage/state-compatibility.mjs'
import { moduleExchangeDiagnostic } from '../src/module-exchange-diagnostic.mjs'

const diagnostic = () => moduleExchangeDiagnostic('usage', 'ready', { code: 'USAGE_READY_INVALID' }, null)
async function fixture(t, value, getter = false) {
  const root = await mkdtemp(join(tmpdir(), 'module-diagnostic-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const release = { componentId: 'usage', sourceCommit: 'b'.repeat(40), versionId: 'c'.repeat(64),
    compatibility: { nodeMajor: 26, parentProtocol: 1, stateSchema: null, containerUpdate: null, stateCompatibility: USAGE_STATE_COMPATIBILITY } }
  const error = new AggregateError([new Error('private SECRET message')], 'private SECRET aggregate')
  if (getter) Object.defineProperty(error, 'moduleDiagnostic', { get() { throw new Error('private SECRET getter') } })
  else if (value !== undefined) error.moduleDiagnostic = value
  let applies = 0
  const options = { root, catalog: { select: async () => ({ catalogSha256: 'd'.repeat(64), expiresAt: '2099-01-01T00:00:00Z', release }) },
    adapters: { usage: { current: () => null, capture: () => ({ generation: 'builtin:test', pid: null }), available: () => true,
      prepare: async () => {}, apply: async () => { applies++; throw error } } } }
  const executor = await createModuleUpdateExecutor(options); t.after(() => executor.close())
  const plan = await executor.plan({ scope: 'component', componentId: 'usage' })
  const request = { planId: plan.planId, requestId: randomUUID(), confirmContainerRestart: false }
  await executor.start(request)
  let operation
  for (let n = 0; n < 100; n++) {
    operation = await executor.operation(request.requestId)
    if (operation.phase === 'unknown') break
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.equal(operation.phase, 'unknown'); assert.equal(operation.error.code, 'UPDATE_MODULE_FAILED')
  const path = join(root, 'state/update-ledger/ledger.json')
  return { executor, options, request, operation, path, ledger: async () => JSON.parse(await readFile(path)), applies: () => applies }
}

test('candidate and rollback evidence stays private, copied, durable and never re-applies the UUID', async t => {
  for (const rollback of ['succeeded', 'failed']) {
    const value = diagnostic()
    if (rollback === 'failed') Object.assign(value, { rollback, rollbackStage: 'resume', rollbackCode: 'USAGE_RESUME_FAILED' })
    const expected = structuredClone(value), f = await fixture(t, value)
    value.stage = 'spawn'
    const before = await f.ledger()
    assert.deepEqual(before.operations[0].steps[0].runtimeDiagnostic, expected)
    assert(!JSON.stringify(before).includes('SECRET'))
    assert(!JSON.stringify(f.operation).includes('runtimeDiagnostic'))
    assert.deepEqual(await f.executor.start(f.request), f.operation)
    await f.executor.close()
    const recovered = await createModuleUpdateExecutor(f.options); t.after(() => recovered.close())
    assert.deepEqual(await recovered.operation(f.request.requestId), f.operation)
    assert.deepEqual(await recovered.start(f.request), f.operation)
    assert.deepEqual(await f.ledger(), before); assert.equal(f.applies(), 1)
  }
})

test('invalid, mismatched and excessive evidence cannot leak into the saved failure', async t => {
  for (const value of [null, { ...diagnostic(), message: 'SECRET' }, { ...diagnostic(), component: 'conversation', code: null },
    { ...diagnostic(), code: 'ARBITRARY_UPPERCASE' }, { ...diagnostic(), code: 'E'.repeat(2048) },
    { ...diagnostic(), rollbackStage: 'ready' }]) {
    const f = await fixture(t, value)
    assert(!Object.hasOwn((await f.ledger()).operations[0].steps[0], 'runtimeDiagnostic'))
  }
})

test('missing legacy evidence and a throwing diagnostic getter preserve the original unknown', async t => {
  for (const getter of [false, true]) {
    const f = await fixture(t, undefined, getter)
    assert(!Object.hasOwn((await f.ledger()).operations[0].steps[0], 'runtimeDiagnostic'))
    await f.executor.close()
    const recovered = await createModuleUpdateExecutor(f.options); t.after(() => recovered.close())
    assert.deepEqual(await recovered.operation(f.request.requestId), f.operation)
    assert.equal(f.applies(), 1)
  }
})

test('a malformed or wrong-component persisted diagnostic is rejected on reconstruction', async t => {
  const f = await fixture(t, diagnostic()); await f.executor.close()
  const original = await f.ledger()
  for (const value of [null, { ...diagnostic(), extra: 'SECRET' }, { ...diagnostic(), component: 'conversation', code: null },
    { ...diagnostic(), rollbackStage: 'resume' }]) {
    const saved = structuredClone(original); saved.operations[0].steps[0].runtimeDiagnostic = value
    await writeFile(f.path, JSON.stringify(saved))
    await assert.rejects(createModuleUpdateExecutor(f.options), { code: 'UPDATE_LEDGER_INVALID' })
  }
  assert.equal(f.applies(), 1)
})
