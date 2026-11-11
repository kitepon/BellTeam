import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createApplicationRuntime } from '../src/application-runtime.mjs'
import { createUsageAssembly } from '../src/usage-assembly.mjs'
import { createUsageParentEffects } from '../src/usage-parent-effects.mjs'
import { USAGE_STATE_COMPATIBILITY } from '../src/usage/state-compatibility.mjs'
import { assertModuleCatalogRelease } from '../src/module-release.mjs'
import { BotRegistry } from '../src/bot-registry.mjs'
import { OwnerProfile } from '../src/owner-profile.mjs'
import { UserRules } from '../src/user-rules.mjs'
import { createSyntheticNotificationsProcess } from './helpers/notifications-process.mjs'

test('usage staged parent assembly authenticates HTTP and seat callers and uses one controller for durable updates', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'usage-common-')), children = []
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'state'))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [
    { id: 'bot-fixture', name: 'Fixture', harness: 'codex', session: 'bot-fixture', project: join(root, 'bots/bot-fixture') },
  ] }))
  const bots = new BotRegistry({ seedPath, botsRoot: join(root, 'bots') }), ownerProfile = new OwnerProfile({ root }), userRules = new UserRules({ root })
  for (const value of [bots, ownerProfile, userRules]) await value.initialize()
  const versions = ['a'.repeat(64), 'c'.repeat(64)], source = 'b'.repeat(40)
  let graph = { bots }, published = versions[0], sharedCloses = 0
  const prepareUsageRelease = async (versionId, options) => {
    const descriptor = { versionId, sourceCommit: source, protocolVersion: 1, platform: { os: 'linux', arch: 'amd64' }, stateCompatibility: USAGE_STATE_COMPATIBILITY,
      appRoot: `/run/bellteam-maintenance/usage/releases/${versionId}/payload` }
    if (options.expectedRelease) assertModuleCatalogRelease('usage', options.expectedRelease, descriptor)
    return descriptor
  }
  const effects = createUsageParentEffects({ getServices: () => graph, getFeatures: () => ({ onChange: graph.settings?.onChange }) })
  const usageAssembly = createUsageAssembly({ root, getServices: () => graph, onEffect: effects, prepareRelease: prepareUsageRelease,
    spawnProcess: (entry, args, options) => {
      assert.equal(entry, '/usr/local/libexec/bellteam-usage-start')
      for (const child of children) { assert.notEqual(child.exitCode, null); assert.equal(child.connected, false); assert.equal(child.stdout.closed, true); assert.equal(child.stderr.closed, true) }
      const child = spawn(process.execPath, [new URL('./fixtures/usage-runtime-child.mjs', import.meta.url).pathname, root, args[0]], options)
      children.push(child); return child
    } })
  t.after(() => usageAssembly.close())
  await usageAssembly.initializeSettings()
  assert.equal(usageAssembly.controller.snapshot().phase, 'initializing')
  assert.equal(usageAssembly.facade.settings.list().length, 7)
  const hostUpdateClient = { capabilities: async () => ({ supported: false, reason: 'HOST_UPDATE_UNAVAILABLE', currentRequestId: null, previousRequestId: null }),
    catalog: async id => {
      const url = `https://github.com/kitepon/BellTeam/releases/download/updates-20261104T000000Z/usage-${source}-linux-amd64.tar.gz`
      return { schema: 'bellteam.update-catalog.selection.v1', catalogSha256: 'd'.repeat(64), publishedAt: '2026-11-04T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
        publication: { status: 'verified', checkedAt: '2026-11-04T00:00:00Z', error: null }, release: id !== 'usage' ? null : {
          componentId: id, versionId: published, sourceCommit: source, platform: { os: 'linux', arch: 'amd64' }, changes: ['usage fixture'],
          compatibility: { nodeMajor: 26, parentProtocol: 1, stateSchema: null, containerUpdate: null, stateCompatibility: USAGE_STATE_COMPATIBILITY },
          artifact: { kind: 'archive', archive: { url, sha256: published, bytes: 1000 }, bundle: { url: url + '.sigstore.json', sha256: 'e'.repeat(64), bytes: 100 }, signerCommit: source },
        } }
    } }
  const allocation = createServer()
  await new Promise(resolve => allocation.listen(0, '127.0.0.1', resolve))
  const internalPort = allocation.address().port
  await new Promise(resolve => allocation.close(resolve))
  const runtime = await createApplicationRuntime({ root, appRoot: new URL('../', import.meta.url).pathname, home: join(root, 'home'),
    environment: { BELLTEAM_WEB_PORT: '0', BELLTEAM_INTERNAL_PORT: String(internalPort) },
    bootstrap: { bots, settings: usageAssembly.facade.settings, ownerProfile, userRules, usageAssembly, attachUsageServices: value => { graph = value },
      refreshGlobalInstructions: async () => {}, aiterm: { command: 'synthetic-aiterm', args: [] },
      createNotificationsProcess: createSyntheticNotificationsProcess, hostUpdateClient, prepareUsageRelease },
    client: { call: async () => ({ content: [{ type: 'text', text: '(セッション無し)' }] }), close: async () => { sharedCloses++ } } })
  t.after(() => runtime.close())
  // This fixture covers the parent wiring; it does not launch AI or shell producers.
  for (const producer of ['scheduler', 'selfTurns', 'seatTurns', 'idleSessions']) runtime.services[producer].start = () => {}
  assert.equal(runtime.services.settings, usageAssembly.facade.settings)
  assert.equal(usageAssembly.controller.snapshot().available, true)
  await runtime.start()
  const port = runtime.gateway.address.port, parent = process.pid
  const call = async (path, body, { internal = false, seat = undefined, method = body ? 'POST' : 'GET' } = {}) => {
    const target = internal ? runtime.internalServer.address().port : port
    const response = await fetch(`http://127.0.0.1:${target}${path}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(seat ? { 'X-Bellteam-Seat': seat } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { response, value: await response.json() }
  }
  let result = await call('/api/settings/routing', { enabled: false }, { method: 'PATCH' })
  assert.equal(result.response.status, 200, JSON.stringify(result.value))
  assert.equal(result.value.setting.enabled, false)
  result = await call('/api/secret-requests', { botId: 'bot-fixture', toolId: 'fixture', label: 'key', message: 'synthetic' }, { internal: true })
  assert.equal(result.response.status, 403)
  result = await call('/api/secret-requests', { botId: 'forged-other-bot', toolId: 'fixture', label: 'key', message: 'synthetic' }, { internal: true, seat: 'bot-fixture' })
  assert.equal(result.response.status, 201, JSON.stringify(result.value))
  const id = result.value.request.id
  assert.equal(result.value.request.botId, 'bot-fixture')
  const mcp = new Client({ name: 'usage-fixture', version: '0' }, { capabilities: {} })
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${internalPort}/mcp`), { requestInit: { headers: { 'X-Bellteam-Seat': 'bot-fixture' } } }))
  t.after(() => mcp.close())
  const card = await mcp.callTool({ name: 'request_secret', arguments: { toolId: 'mcp-fixture', label: 'key', message: 'synthetic MCP' } })
  assert.equal(JSON.parse(card.content[0].text).request.botId, 'bot-fixture')
  await mcp.close()
  result = await call('/api/secret-requests/' + id)
  assert.equal(result.response.status, 200); assert.equal(result.value.request.status, 'pending')
  const update = async action => {
    const plan = await call('/api/updates/plans', { scope: 'component', componentId: 'usage', ...(action ? { action } : {}) })
    assert.equal(plan.response.status, 200, JSON.stringify(plan.value))
    const requestId = randomUUID()
    const started = await call('/api/updates/operations', { planId: plan.value.plan.planId, requestId, confirmContainerRestart: false })
    assert.equal(started.response.status, 202, JSON.stringify(started.value))
    for (let i = 0; i < 200; i++) {
      const { value } = await call('/api/updates/operations/' + requestId)
      if (['completed', 'failed', 'unknown'].includes(value.operation.phase)) { assert.equal(value.operation.phase, 'completed', JSON.stringify(value)); return }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.fail('usage operation did not complete')
  }
  await update(); published = versions[1]; await update(); await update('rollback')
  assert.equal(usageAssembly.controller.snapshot().currentVersionId, versions[0])
  result = await call('/api/secret-requests/' + id)
  assert.equal(result.value.request.status, 'pending')
  assert.equal(runtime.gateway.address.port, port); assert.equal(process.pid, parent); assert.equal(sharedCloses, 0)
  await runtime.close(); assert.equal(sharedCloses, 1)
  assert.equal(JSON.parse(await readFile(join(root, 'state/secret-requests', id + '.json'))).botId, 'bot-fixture')
  for (const child of children) assert.equal(child.exitCode, 0)
})
