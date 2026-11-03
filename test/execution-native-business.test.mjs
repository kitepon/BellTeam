import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createExecutionNativeFixture } from './helpers/execution-native-business.mjs'
import { createExecutionAdoptionStore } from '../src/execution-adoption.mjs'
async function rootFor(t) {
  const root = await mkdtemp(join(tmpdir(), 'execution-native-business-'))
  await mkdir(join(root, 'state'), { mode: 0o700 })
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
test('native fixture is synchronous/dormant and refuses completion without fabricated exchanges', async t => {
  const root = await rootFor(t), f = createExecutionNativeFixture({ root })
  assert.equal(f instanceof Promise, false); assert.equal(typeof f.controller.replace, 'function')
  assert.equal(f.snapshot().started, false); assert.equal(f.snapshot().generations, 0)
  assert.equal(f.snapshot().syntheticLaunches, 0); assert.equal(f.snapshot().sdkCloses, 0)
  await assert.rejects(f.verify(), /EXECUTION_FIXTURE_EXCHANGE_INCOMPLETE/)
  assert.throws(() => createExecutionNativeFixture({ root: './relative' }), { code: 'EXECUTION_FIXTURE_ROOT_INVALID' })
  await f.close(); assert.equal(f.snapshot().closed, true)
  assert.ok(Object.values(f.snapshot()).every(value => typeof value === 'boolean' || Number.isSafeInteger(value)))
  assert.doesNotMatch(JSON.stringify(f.snapshot()), /synthetic-execution-session|synthetic fixture only|launch_id|\/tmp\//)
})
test('native fixture refuses an existing parent selection before touching default loader or engines', async t => {
  const root = await rootFor(t), store = createExecutionAdoptionStore({ root })
  const selected = { currentVersionId: 'a'.repeat(64), previousVersionId: null }
  await store.save(selected)
  const f = createExecutionNativeFixture({ root })
  await assert.rejects(f.start(), { code: 'EXECUTION_FIXTURE_ROOT_NOT_EMPTY' })
  assert.deepEqual(await store.read(), selected); assert.equal(f.snapshot().syntheticLaunches, 0)
  await f.close()
})
test('native fixture uses actual fixed builtin loader and never substitutes a factory when entry is absent', async t => {
  const root = await rootFor(t), f = createExecutionNativeFixture({ root })
  t.after(() => f.close().catch(() => {}))
  let present = true
  try { await access('/app/src/execution-dispatcher.mjs') } catch (error) { assert.equal(error.code, 'ENOENT'); present = false }
  if (!present) {
    await assert.rejects(f.start(), { code: 'ERR_MODULE_NOT_FOUND' })
    assert.equal(f.snapshot().started, false); assert.equal(f.snapshot().syntheticLaunches, 0)
  } else {
    const state = await f.start()
    assert.equal(state.started, true); assert.equal(state.sessionKept, true); assert.equal(state.samePorts, true)
    await assert.rejects(f.replace('builtin'), { code: 'EXECUTION_FIXTURE_TARGET_UNCHANGED' })
  }
  assert.equal(f.snapshot().exchanges, 0); await assert.rejects(f.verify(), /EXECUTION_FIXTURE_EXCHANGE_INCOMPLETE/)
  await f.close(); assert.equal(f.snapshot().sdkCloses, 0); assert.equal(f.snapshot().ptyCloses, 0)
})

test('synthetic loader unit check exercises the new guest drain/save/restore assertions only', async t => {
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { mock } from 'node:test'
    import { mkdtemp, mkdir, rm } from 'node:fs/promises'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { createExecutionDispatcher } from './src/execution-dispatcher.mjs'
    const base = '48e508bab1c1cad2f8c3220f062715b27bcd3376'
    const loads = []
    mock.module('./src/execution-loader.mjs', { namedExports: {
      loadExecutionFactory: async versionId => {
        loads.push(versionId)
        return Object.freeze({ versionId, sourceCommit: base, createExecutionDispatcher })
      }
    } })
    const { createExecutionNativeFixture } = await import('./test/helpers/execution-native-business.mjs')
    const root = await mkdtemp(join(tmpdir(), 'execution-guest-synthetic-'))
    await mkdir(join(root, 'state'), { mode: 0o700 })
    const fixture = createExecutionNativeFixture({ root }), signed = 'b'.repeat(64)
    try {
      await fixture.start()
      await fixture.replace(signed)
      await fixture.replace('builtin')
      const state = await fixture.verify()
      assert.deepEqual(loads, [null, signed, null])
      assert.equal(state.generations, 3)
      assert.equal(state.adoptionAcks, 2)
      assert.equal(state.ackAdmissionClosed, 2)
      assert.equal(state.drainAdmissionClosed, 2)
      assert.equal(state.selectionDurable, true)
      assert.equal(state.builtinSourceMatched, true)
      assert.equal(state.externalEffects, 0)
      console.log(JSON.stringify({ scope: 'synthetic-loader-unit-only', ...state }))
    } finally { await fixture.close(); await rm(root, { recursive: true, force: true }) }
  `], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10_000 })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /synthetic-loader-unit-only/)
  t.diagnostic(result.stdout.trim())
})
