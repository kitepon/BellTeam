import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createApplicationRuntime } from '../src/application-runtime.mjs'
import { createExecutionAssembly } from '../src/execution-assembly.mjs'
import { createExecutionFactoryLoader } from '../src/execution-loader.mjs'
import * as engine from '../src/execution-dispatcher.mjs'
import { BotRegistry } from '../src/bot-registry.mjs'
import { OwnerProfile } from '../src/owner-profile.mjs'
import { UserRules } from '../src/user-rules.mjs'
import { FeatureSettings } from '../src/feature-settings.mjs'
import { createSyntheticNotificationsProcess } from './helpers/notifications-process.mjs'

test('normal parent callers and durable Update use one execution engine without outer producers or shared-client closure', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'execution-common-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'state'), { mode: 0o700 })
  const seedPath = join(root, 'seed.json'); await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [] }))
  const bots = new BotRegistry({ seedPath, botsRoot: join(root, 'bots') }), settings = new FeatureSettings({ root, environment: {} })
  const ownerProfile = new OwnerProfile({ root }), userRules = new UserRules({ root })
  for (const value of [bots, settings, ownerProfile, userRules]) await value.initialize()
  const version = 'a'.repeat(64), source = 'b'.repeat(40), calls = []
  let clientCloses = 0, assembly, continuationPort
  const client = { async connect() {}, async call(method) { calls.push(method); assert.equal(method, 'pty_list'); return { content: [{ type: 'text', text: '' }] } }, async close() { clientCloses++ } }
  const descriptor = async id => ({ versionId: id, sourceCommit: source, protocolVersion: 1, platform: { os: 'linux', arch: 'amd64' },
    stateCompatibility: engine.EXECUTION_STATE_COMPATIBILITY, appRoot: `/run/bellteam-maintenance/execution/releases/${id}/payload` })
  const loadExecutionFactory = createExecutionFactoryLoader({ prepareRelease: descriptor,
    builtinIdentity: async () => 'f'.repeat(40), importFactory: async () => engine })
  const hostUpdateClient = { capabilities: async () => ({ supported: false, reason: 'HOST_UPDATE_UNAVAILABLE', currentRequestId: null, previousRequestId: null }),
    catalog: async id => {
      const url = `https://github.com/kitepon/BellTeam/releases/download/updates-20261104T000000Z/execution-${source}-linux-amd64.tar.gz`
      return { schema: 'bellteam.update-catalog.selection.v1', catalogSha256: 'd'.repeat(64), publishedAt: '2026-11-04T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
        publication: { status: 'verified', checkedAt: '2026-11-04T00:00:00Z', error: null }, release: id !== 'execution' ? null : {
          componentId: id, versionId: version, sourceCommit: source, platform: { os: 'linux', arch: 'amd64' }, changes: ['execution fixture'],
          compatibility: { nodeMajor: 26, parentProtocol: 1, stateSchema: null, containerUpdate: null, stateCompatibility: engine.EXECUTION_STATE_COMPATIBILITY },
          artifact: { kind: 'archive', archive: { url, sha256: version, bytes: 1000 }, bundle: { url: url + '.sigstore.json', sha256: 'e'.repeat(64), bytes: 100 }, signerCommit: source },
        } }
    } }
  const runtime = await createApplicationRuntime({ root, appRoot: new URL('../', import.meta.url).pathname, home: join(root, 'home'),
    environment: { BELLTEAM_WEB_PORT: '0', BELLTEAM_INTERNAL_PORT: '0' }, client,
    bootstrap: { bots, settings, ownerProfile, userRules, refreshGlobalInstructions: async () => {}, aiterm: { command: 'synthetic-aiterm', args: [] },
      createNotificationsProcess: createSyntheticNotificationsProcess, hostUpdateClient, loadExecutionFactory, prepareExecutionRelease: descriptor,
      createExecutionAssembly: options => {
        // Test storage has the current fixture UID; production keeps the fixed 1001 contract.
        options.ports.configurationStorage.ownerUid = process.getuid()
        continuationPort = options.ports.continuation.messenger
        assembly = createExecutionAssembly(options); return assembly
      },
    } })
  t.after(() => runtime.close())
  assert.equal(runtime.services.execution, assembly)
  assert.equal(runtime.services.transport, assembly.transport); assert.equal(runtime.services.administration, assembly.administration)
  assert.equal(runtime.services.goals, assembly.goals); assert.equal(runtime.services.transport.client, client)
  assert.equal(runtime.services.idleSessions, null); assert.equal(runtime.services.seatTurns, null)
  assert.deepEqual(runtime.services.transport.queueItems(), [])
  assert.equal(runtime.services.transport.queueItems() instanceof Promise, false)
  const originalSend = runtime.services.messenger.sendmessage
  const message = { from: 'scheduler', target: 'bot-fixture', message: 'synthetic pointer only' }, options = { admissionCheck() {} }
  const receipt = Object.assign(Promise.resolve({ delivery_id: 'fixture-delivery' }), { completion: Promise.resolve() })
  runtime.services.messenger.sendmessage = (input, context) => { assert.equal(input, message); assert.equal(context, options); return receipt }
  assert.equal(continuationPort.sendmessage(message, options), receipt)
  runtime.services.messenger.sendmessage = originalSend
  await runtime.start()
  const port = runtime.gateway.address.port, parent = process.pid, stableTransport = runtime.services.transport
  const request = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/updates${path}`, body ? { method: 'POST', body: JSON.stringify(body) } : {})
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value
  }
  const exchange = async action => {
    const { plan } = await request('/plans', { scope: 'component', componentId: 'execution', ...(action ? { action } : {}) }), requestId = randomUUID()
    await request('/operations', { planId: plan.planId, requestId, confirmContainerRestart: false })
    for (let i = 0; i < 200; i++) {
      const { operation } = await request('/operations/' + requestId)
      if (['completed', 'failed', 'unknown'].includes(operation.phase)) { assert.equal(operation.phase, 'completed', JSON.stringify(operation)); return }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.fail('execution operation did not finish')
  }
  await exchange(); assert.equal(assembly.controller.snapshot().currentVersionId, version)
  const record = join(root, 'state/execution-release.json')
  assert.equal(JSON.parse(await readFile(record)).currentVersionId, version); assert.equal((await stat(record)).mode & 0o777, 0o600)
  await exchange('rollback')
  assert.equal(assembly.controller.snapshot().currentVersionId, null)
  assert.equal(JSON.parse(await readFile(record)).currentVersionId, null)
  assert.equal(runtime.services.transport, stableTransport); assert.equal(runtime.gateway.address.port, port)
  assert.equal(process.pid, parent); assert.equal(clientCloses, 0)
  await runtime.close(); assert.equal(clientCloses, 1)
  assert.equal(assembly.controller.snapshot().phase, 'closed')
  assert.ok(calls.every(method => method === 'pty_list'))
})
