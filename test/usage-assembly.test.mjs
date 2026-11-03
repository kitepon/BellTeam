import test from 'node:test'
import assert from 'node:assert/strict'
import { createUsageAssembly } from '../src/usage-assembly.mjs'

test('usage assembly retains captured authority and admission until actual completion after caller failure', async () => {
  let ports, options, finish, currentMethod
  const completion = new Promise(resolve => { finish = resolve })
  const attempt = Promise.reject(Object.assign(new Error('CALLER_TIMEOUT'), { code: 'CALLER_TIMEOUT' }))
  attempt.catch(() => {})
  Object.defineProperty(attempt, 'completion', { value: completion })
  const assembly = createUsageAssembly({ root: '/unused', getServices: () => ({ bots: new Map() }), onEffect: () => {},
    createProcess: value => {
      ports = value
      return { request(method, params, context) { currentMethod = method; options = context; return attempt } }
    } })
  const token = assembly.capture('settings.update', { kind: 'owner', botId: null })
  assert.equal(assembly.facade.settings.update('routing', { enabled: false }, { usageContext: token }), attempt)
  await assert.rejects(attempt, /CALLER_TIMEOUT/)
  assert.equal(ports.authorizeActor(currentMethod, options.capturedAuthorization).kind, 'owner')
  ports.admission.assertLease(options.usageLease)
  const ticket = ports.admission.close()
  let drained = false
  const draining = ports.admission.drain(ticket).then(() => { drained = true })
  await Promise.resolve(); assert.equal(drained, false)
  finish(); await draining
  assert.throws(() => ports.authorizeActor(currentMethod, token), /FORBIDDEN/)
  assert.throws(() => ports.admission.assertLease(options.usageLease), /NOT_ACCEPTED/)
  assert.throws(() => assembly.facade.settings.update('routing', {}, { usageContext: {} }), /FORBIDDEN/)
})

test('usage effect callbacks keep the original parent identity and bootstrap exposes only fixed environment values', async () => {
  let ports, assembly, callbackOptions
  const lease = Object.freeze({}), effect = Object.freeze({})
  assembly = createUsageAssembly({ root: '/unused', getServices: () => ({ bots: new Map() }),
    environment: { TYPESAFE_API_KEY: 'fixture', UNRELATED_SECRET: 'never sent' },
    onEffect: async () => {
      await Promise.resolve()
      return assembly.facade.settings.setError('routing', { code: 'FIXTURE_ERROR' }, { epoch: 2, usageContext: assembly.systemContext('settings.setError') })
    },
    createProcess: value => {
      ports = value
      return { callback(method, params, options) {
        assert.equal(method, 'settings.setError'); assert.equal(params.epoch, 2)
        assert.equal(value.authorizeActor(method, options.capturedAuthorization).kind, 'system')
        callbackOptions = options
        const result = Promise.resolve(null); Object.defineProperty(result, 'completion', { value: result }); return result
      } }
    } })
  assert.deepEqual(ports.bootstrap.environment, { TYPESAFE_API_KEY: 'fixture' })
  await ports.onEffect('settings.changed', {}, { usageLease: lease, usageEffect: effect })
  assert.equal(callbackOptions.usageLease, lease); assert.equal(callbackOptions.usageEffect, effect)
  assert.throws(() => ports.authorizeActor('settings.setError', callbackOptions.capturedAuthorization), /FORBIDDEN/)
})
