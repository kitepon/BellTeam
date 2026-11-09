import test from 'node:test'
import assert from 'node:assert/strict'
import { createUsageAssembly } from '../src/usage-assembly.mjs'
import { developerAccessAllowed } from '../src/distribution-profile.mjs'
import { copyFile, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

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
    environment: { TYPESAFE_API_KEY: 'fixture', UNRELATED_SECRET: 'never sent', BELLTEAM_SUBSCRIPTION_ACCESS_MODE: 'developer', BELLTEAM_SUBSCRIPTION_DEVELOPER_ACCESS_ALLOWED: String(!developerAccessAllowed) },
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
  assert.equal(ports.bootstrap.subscription.developerAccessAllowed, developerAccessAllowed)
  await ports.onEffect('settings.changed', {}, { usageLease: lease, usageEffect: effect })
  assert.equal(callbackOptions.usageLease, lease); assert.equal(callbackOptions.usageEffect, effect)
  assert.throws(() => ports.authorizeActor('settings.setError', callbackOptions.capturedAuthorization), /FORBIDDEN/)
})

test('public parent bootstrap retains the legacy subscription fields and refuses developer access despite environment input', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-public-usage-assembly-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await copyFile(new URL('../src/usage-assembly.mjs', import.meta.url), join(root, 'usage-assembly.mjs'))
  await copyFile(new URL('../distribution/server/distribution-profile.mjs', import.meta.url), join(root, 'distribution-profile.mjs'))
  for (const path of ['members-admission.mjs', 'usage-process.mjs', 'usage']) {
    await symlink(new URL('../src/' + path, import.meta.url), join(root, path))
  }
  const { createUsageAssembly: createPublicAssembly } = await import(pathToFileURL(join(root, 'usage-assembly.mjs')))
  let bootstrap
  const options = { root: '/unused', getServices: () => ({ bots: new Map() }),
    createProcess: value => { bootstrap = value.bootstrap; return {} },
    environment: { BELLTEAM_SUBSCRIPTION_DEVELOPER_ACCESS_ALLOWED: 'true' } }
  createPublicAssembly(options)
  assert.deepEqual(bootstrap.subscription, { environment: 'Production', accessMode: 'subscription' })
  assert.throws(() => createPublicAssembly({ ...options, environment: { ...options.environment, BELLTEAM_SUBSCRIPTION_ACCESS_MODE: 'developer' } }), {
    message: 'SUBSCRIPTION_DEVELOPER_ACCESS_UNAVAILABLE',
  })
})

test('C5 credentials facade captures system authority and routes native capabilities without exposing their source', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-credential-assembly-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let ports
  const calls = []
  const childDto = { handle: 'child-handle', revision: 1, available: true }
  const assembly = createUsageAssembly({ root, getServices: () => ({ bots: new Map() }), onEffect() {},
    createProcess(value) {
      ports = value
      return { request(method, params, context) {
        assert.deepEqual(value.authorizeActor(method, context.capturedAuthorization), { kind: 'system', botId: null })
        calls.push({ method, params })
        const result = Promise.resolve(method === 'secrets.resolve' ? 'synthetic-value' : method === 'secrets.refresh' ? null : childDto)
        Object.defineProperty(result, 'completion', { value: result }); return result
      }, close() {} }
    } })
  t.after(() => assembly.close())
  const scope = { terminalId: 'owner-macbook', purpose: 'terminal.ssh' }, context = { ...scope, memberId: null }
  assert.deepEqual(await assembly.credentials.bind('request-a', scope), childDto)
  await assembly.credentials.withResolved(childDto.handle, context, value => assert.equal(value, 'synthetic-value'))
  assert.equal(calls.at(-1).method, 'secrets.resolve')
  const ref = '1f046271-3e79-4549-8f0b-79f2d6f729ae', revision = 'sha256:' + 'a'.repeat(64)
  const target = { host: '192.0.2.2', user: 'synthetic', port: 22 }
  assembly.credentials.setNativeProvider({ status: async current => ({ ref: current, target, credential: { provider: 'aiterm.native-ssh-key.v1', revision, available: true } }) })
  const dto = await assembly.credentials.registerNative({ ref, target }, scope)
  const count = calls.length
  await assembly.credentials.withResolved(dto.handle, context, capability => assert.deepEqual(capability, { nativeKeyRef: ref, revision }))
  assert.equal(calls.length, count)
  assert.equal(JSON.stringify(dto).includes(ref), false)
  assert.equal((await assembly.credentials.credential(dto.handle, context)).revision, 1)
  await assembly.credentials.refresh()
  assert.equal(calls.at(-1).method, 'secrets.refresh')
})

test('a one-shot terminal.login value reaches the consumer although the child revoked its handle during resolve', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-login-assembly-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const login = { terminalId: 'owner-macbook', purpose: 'terminal.login' }
  let assembly
  assembly = createUsageAssembly({ root, getServices: () => ({ bots: new Map() }), onEffect() {},
    createProcess() {
      return { request(method, params) {
        const result = (async () => {
          if (method !== 'secrets.resolve') return null
          await assembly.credentials.unbind(null, login) // the revoke lands before the value, as the child's unbound projection does
          return 'synthetic-login'
        })()
        Object.defineProperty(result, 'completion', { value: result }); return result
      }, close() {} }
    } })
  t.after(() => assembly.close())
  let got
  await assembly.credentials.withResolved('child-handle', { ...login, memberId: null }, value => { got = value })
  assert.equal(got, 'synthetic-login')
})
