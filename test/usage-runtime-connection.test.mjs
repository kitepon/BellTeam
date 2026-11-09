import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import test from 'node:test'
import { createUsageAuthority } from '../src/usage/authority.mjs'
import { createUsageProjection } from '../src/usage/projection.mjs'
import { createUsageFacade } from '../src/usage/facade.mjs'
import { createApplicationFeatures } from '../src/usage/application-features.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const runtimeInput = process.env.BELLTEAM_USAGE_RUNTIME_INPUT ?? fileURLToPath(new URL('..', import.meta.url))
const wrapper = join(runtimeInput, 'src/usage-process.mjs')

test('installed-reader refusal and real wrapper/facade/apply connection keep state through staged activation, exchange and cold adoption restart', { timeout: 30000, skip: !existsSync(wrapper) }, async t => {
  const { createUsageProcess } = await import(pathToFileURL(wrapper))
  const root = await mkdtemp(join(tmpdir(), 'usage-runtime-connection-')), children = [], messages = [], authCalls = []
  await mkdir(join(root, 'state'))
  const stopped = deferred(), stopStarted = deferred()
  let stopPending = false
  const parents = [], bots = new Map([['bot-a', { id: 'bot-a', name: 'A', harness: 'codex' }]])
  t.after(async () => {
    for (const parent of parents) await parent.controller.close().catch(() => {})
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  })
  const spawnProcess = (entry, args, options) => {
    assert.equal(entry, '/usr/local/libexec/bellteam-usage-start'); assert.equal(options.serialization, 'advanced')
    for (const child of children) assert.notEqual(child.exitCode, null)
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/usage-runtime-child.mjs', import.meta.url)), root, args[0]], options)
    children.push(child); return child
  }
  const makeParent = prepareRelease => {
    const admission = new MembersAdmission('usage-parent'), authority = createUsageAuthority(), projection = createUsageProjection({ bots })
    let controller, features
    const effectScope = new AsyncLocalStorage()
    const facade = createUsageFacade({ projection, toolsDirectory: join(root, 'state/secret-values'), request: (method, params, token) => {
      if (token?.usageEffect) return controller.callback(method, params, token).finally(() => authority.release(token.capturedAuthorization))
      return admission.withLease(async lease => {
        try { return await controller.request(method, params, { usageLease: lease, capturedAuthorization: token }) }
        finally { authority.release(token) }
      })
    } })
    controller = createUsageProcess({ root, admission, authorizeActor: authority.authorizeActor, spawnProcess,
      ...(prepareRelease ? { prepareRelease } : {}), bootstrap: { environment: {}, seatRuntime: false, subscription: {} },
      onEffect: (method, params, context) => effectScope.run(context, async () => {
        if (method === 'members.read') return [...bots.values()]
        if (method === 'rooms.read') return []
        if (method === 'settings.changed') return await facade.settings.onChange(params.id, params.configuration, { epoch: params.epoch }) ?? null
        if (method === 'secret.completed') { messages.push(params); return null }
        if (method === 'auth.call') { authCalls.push(params); return { structuredContent: { schema: 'aiterm.agent-auth-result.v1', status: 'waiting', session_id: 'actual-wrapper-session' } } }
        if (method === 'secret.created') return null
        throw new Error('UNEXPECTED_PARENT_EFFECT')
      }),
      onProjection: (row, context) => context.phase === 'seed' ? projection.seed(row, context.generation) : facade.accept(row, context.generation),
      onSnapshotStart: context => projection.begin(context.generation), onSnapshotEnd: context => projection.commit(context.generation),
      onSnapshotAbort: context => projection.discard(context.generation),
    })
    const token = (method, kind = 'owner') => authority.capture(method, { kind, botId: kind === 'bot' ? 'bot-a' : null })
    const parent = { controller, facade, token, async start() {
      const starting = await controller.start(); assert.equal(starting.available, false); assert.equal(starting.phase, 'initializing')
      assert.equal(facade.settings.list().length, 7)
      features = createApplicationFeatures({ services: { bots, settings: facade.settings, messenger: {}, diagnostics: { record: async () => {} },
        notifications: { initialStatus: async () => null }, transport: { isRunning: async () => stopPending, stopForConfiguration: async () => { stopStarted.resolve(); return stopped.promise } } }, home: '/unused', environment: {},
        configureHarnessConfig: async () => {}, notify: () => {}, usageContext: method => {
          const capturedAuthorization = token(method, 'system'), context = effectScope.getStore()
          return context ? { usageLease: context.usageLease, usageEffect: context.usageEffect, capturedAuthorization } : capturedAuthorization
        } })
      await assert.rejects(controller.request('settings.list', {}), /NOT_ACCEPTING/)
      await controller.initialize('subscriptions'); await controller.initialize('services'); await controller.activate(); await features.initialize()
      assert.equal(controller.snapshot().available, true)
    }, async close() { await features.close(); await controller.close() } }
    parents.push(parent); return parent
  }
  const initial = makeParent(); await initial.start()
  await initial.facade.settings.update('routing', { enabled: true, values: { apiKey: 'synthetic-wrapper-key' } }, { usageContext: initial.token('settings.update') })
  const item = await initial.facade.secretRequests.create({ botId: 'bot-a', toolId: 'synthetic', label: '鍵', message: '入力' }, initial.token('secrets.create', 'bot'))
  const saved = await initial.facade.secretRequests.submit(item.id, 'synthetic-wrapper-value', initial.token('secrets.submit'))
  const pid = children[0].pid
  await assert.rejects(initial.controller.replace('9'.repeat(64)), error => ['ENOENT', 'EACCES'].includes(error.code) || /^GATEWAY_RELEASE_/.test(error.code))
  assert.equal(children.length, 1); assert.equal(children[0].pid, pid); assert.equal(children[0].exitCode, null)
  assert.equal(initial.controller.snapshot().available, true); assert.equal(initial.facade.secretRequests.get(item.id).status, 'submitted')
  await initial.close()

  // Actual installed-reader rejection above is separate from these explicit descriptor fixtures.
  const descriptor = async versionId => ({ versionId, appRoot: `/run/bellteam-maintenance/usage/releases/${versionId}/payload` })
  const hot = makeParent(descriptor); await hot.start()
  const stable = hot.facade
  await hot.facade.harnessAuth.start('codex', hot.token('auth.start'))
  await hot.facade.settings.update('routing', { enabled: false }, { usageContext: hot.token('settings.update') })
  const epoch = hot.facade.settings.routingState().epoch
  stopPending = true
  const updating = hot.facade.settings.update('callBridge', { enabled: false }, { usageContext: hot.token('settings.update') })
  await stopStarted.promise
  const replacing = hot.controller.replace('a'.repeat(64))
  await new Promise(resolve => setImmediate(resolve))
  stopped.reject(Object.assign(new Error('synthetic stop failure'), { code: 'SYNTHETIC_CONFIGURATION_STOP', status: 503 }))
  assert.equal((await updating).error.code, 'SYNTHETIC_CONFIGURATION_STOP'); await replacing
  stopPending = false
  assert.equal(hot.facade.settings.list().find(item => item.id === 'callBridge').error.code, 'SYNTHETIC_CONFIGURATION_STOP')
  assert.equal(hot.facade, stable); assert.equal(hot.facade.settings.routingState().epoch, epoch)
  assert.equal(hot.facade.secretRequests.get(item.id).notification, 'sent')
  await hot.facade.harnessAuth.status('codex', hot.token('auth.status'))
  assert.equal(authCalls.at(-1).session_id, 'actual-wrapper-session')
  await hot.close()
  const count = authCalls.length
  const cold = makeParent(descriptor); await cold.start()
  assert.equal(cold.controller.snapshot().currentVersionId, 'a'.repeat(64))
  assert.equal(authCalls.length, count); assert.equal(cold.facade.settings.routingState().epoch, 0)
  assert.equal(cold.facade.settings.configuration('routing').apiKey, 'synthetic-wrapper-key')
  assert.equal(await readFile(saved.path, 'utf8'), 'synthetic-wrapper-value'); assert.equal(messages.length, 1)
  await cold.controller.replace('builtin')
  assert.equal(cold.controller.snapshot().currentVersionId, null); assert.equal(cold.facade.secretRequests.get(item.id).status, 'submitted')
  await cold.close()
  assert.equal(children.length, 5)
  for (const child of children) { assert.equal(child.exitCode, 0); assert.equal(child.connected, false); assert.equal(child.stdout.closed, true) }
})
