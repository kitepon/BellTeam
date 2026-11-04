import test from 'node:test'
import assert from 'node:assert/strict'
import { createUsageParentEffects } from '../src/usage-parent-effects.mjs'
import { validateCurrentWork } from '../src/current-work-contract.mjs'

test('background model effect reads the shared catalog and exposes only model id and efforts', async () => {
  const calls = [], effect = createUsageParentEffects({ getServices: () => ({ models: { async list(harness) {
    calls.push(harness)
    return { codex: { models: [{ id: 'candidate', efforts: ['high'], private: 'hidden' }] } }
  } } }) })
  assert.deepEqual(await effect('backgroundAgent.models', { harness: 'codex' }), [{ id: 'candidate', efforts: ['high'] }])
  assert.deepEqual(calls, ['codex'])
  const unavailable = createUsageParentEffects({ getServices: () => ({ models: { list: async () => ({ codex: { models: [], error: { code: 'MODEL_CATALOG_UNAVAILABLE' } } }) } }) })
  await assert.rejects(unavailable('backgroundAgent.models', { harness: 'codex' }), { code: 'BACKGROUND_AGENT_MODELS_UNAVAILABLE' })
})

test('settings notification follows actual configure completion and survives missing executor', async () => {
  const configuration = { revision: null, selection: null }, events = []
  let finish
  const completion = new Promise(resolve => { finish = resolve })
  const effect = createUsageParentEffects({ getServices: () => ({
    backgroundSummary: { configure: value => { assert.equal(value, configuration); return Object.assign(Promise.resolve(), { completion }) } },
    notify: value => events.push(value),
  }) })
  const pending = effect('backgroundAgent.changed', { configuration })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events, [])
  finish(); assert.equal(await pending, null)
  assert.deepEqual(events, [{ type: 'settings', featureId: 'backgroundAgent' }])
  const missing = createUsageParentEffects({ getServices: () => ({ notify: value => events.push(value) }) })
  await assert.rejects(missing('backgroundAgent.changed', { configuration }), { code: 'BACKGROUND_AGENT_UNAVAILABLE' })
  assert.equal(events.length, 2)
})

test('automatic summaries keep nine independent states while legacy self reports keep their original states', () => {
  const at = '2026-11-04T23:00:00Z'
  for (const state of ['working', 'idle', 'unknown']) for (const status of ['current', 'missing', 'stale']) {
    const value = { state, summary: status === 'current' ? '今の仕事' : null, summaryStatus: status,
      summaryUpdatedAt: status === 'missing' ? null : at, observedAt: state === 'unknown' ? null : at,
      source: status === 'missing' ? null : 'background_agent' }
    assert.equal(validateCurrentWork(value).valid, true, `${state}/${status}`)
    if (status !== 'missing') {
      assert.equal(validateCurrentWork({ ...value, source: 'self_reported' }).valid, state === 'working')
      assert.equal(validateCurrentWork({ ...value, source: 'unrecognized' }).valid, false)
    }
    if (status !== 'current') assert.equal(validateCurrentWork({ ...value, summary: 'invented' }).valid, false)
    if (state !== 'unknown') assert.equal(validateCurrentWork({ ...value, observedAt: null }).valid, false)
  }
})
