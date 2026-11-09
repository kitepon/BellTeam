import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createApplicationRuntime } from '../src/application-runtime.mjs'
import { createApplicationServices } from '../src/application-services.mjs'
import { createDiagnosticsProcess } from '../src/diagnostics-process.mjs'
import { createDiagnosticsAdminServer } from '../src/diagnostics.mjs'
import { assertModuleCatalogRelease } from '../src/module-release.mjs'
import { DIAGNOSTICS_STATE_COMPATIBILITY } from '../src/diagnostics-protocol.mjs'
import { BotRegistry } from '../src/bot-registry.mjs'
import { OwnerProfile } from '../src/owner-profile.mjs'
import { UserRules } from '../src/user-rules.mjs'
import { FeatureSettings } from '../src/feature-settings.mjs'
import { createSyntheticNotificationsProcess } from './helpers/notifications-process.mjs'
import { createFixtureJobClient } from './fixtures/update-job-client.mjs'

const sourceCommit = 'b'.repeat(40), versions = ['a'.repeat(64), 'c'.repeat(64)]
const selection = (component, versionId) => {
  const url = `https://github.com/kitepon/BellTeam/releases/download/updates-20261103T000000Z/diagnostics-${sourceCommit}-linux-amd64.tar.gz`
  return { schema: 'bellteam.update-catalog.selection.v1', catalogSha256: 'd'.repeat(64), publishedAt: '2026-11-03T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
    publication: { status: 'verified', checkedAt: '2026-11-03T00:00:00Z', error: null }, release: component === 'diagnostics' ? {
      componentId: component, sourceCommit, versionId, platform: { os: 'linux', arch: 'amd64' }, changes: ['診断writerの更新'],
      compatibility: { nodeMajor: 26, parentProtocol: 1, stateSchema: null, containerUpdate: null, stateCompatibility: DIAGNOSTICS_STATE_COMPATIBILITY },
      artifact: { kind: 'archive', archive: { url, sha256: versionId, bytes: 1000 }, bundle: { url: url + '.sigstore.json', sha256: 'e'.repeat(64), bytes: 100 }, signerCommit: sourceCommit },
    } : null }
}
async function bootstrap(t) {
  const root = await mkdtemp(join(tmpdir(), 'diagnostics-common-')); t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'state'))
  const seedPath = join(root, 'seed.json'); await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [] }))
  const bots = new BotRegistry({ seedPath, botsRoot: join(root, 'bots') }), settings = new FeatureSettings({ root, environment: {} })
  const ownerProfile = new OwnerProfile({ root }), userRules = new UserRules({ root })
  for (const value of [bots, settings, ownerProfile, userRules]) await value.initialize()
  return { root, bots, settings, ownerProfile, userRules, aiterm: { command: 'synthetic-aiterm', args: [] }, refreshGlobalInstructions: async () => {} }
}

test('normal diagnostics factory feeds the stable facade, admin API, real controller and durable update ledger without a second writer', { timeout: 15000 }, async t => {
  const initial = await bootstrap(t), children = [], root = initial.root
  let activeVersion = versions[0], controller, clientCloses = 0
  const hostUpdateClient = { ...createFixtureJobClient(root), jobs: async () => ({ jobs: [] }), capabilities: async () => ({ supported: false, reason: 'HOST_UPDATE_UNAVAILABLE', currentRequestId: null, previousRequestId: null }), catalog: async id => selection(id, activeVersion) }
  const prepareDiagnosticsRelease = async (versionId, options) => {
    const descriptor = { versionId, sourceCommit, platform: { os: 'linux', arch: 'amd64' }, protocolVersion: 1,
      stateCompatibility: DIAGNOSTICS_STATE_COMPATIBILITY, appRoot: `/run/bellteam-maintenance/diagnostics/releases/${versionId}/payload` }
    if (options.expectedRelease) assertModuleCatalogRelease('diagnostics', options.expectedRelease, descriptor)
    return descriptor
  }
  const runtime = await createApplicationRuntime({ root, appRoot: new URL('../', import.meta.url).pathname, home: join(root, 'home'),
    environment: { BELLTEAM_WEB_PORT: '0', BELLTEAM_INTERNAL_PORT: '0' },
    bootstrap: { ...initial, createNotificationsProcess: createSyntheticNotificationsProcess, hostUpdateClient, prepareDiagnosticsRelease,
      createDiagnosticsProcess: options => controller = createDiagnosticsProcess({ ...options, spawnProcess: (entry, args, spawnOptions) => {
        assert.equal(entry, '/usr/local/libexec/bellteam-diagnostics-start')
        for (const old of children) { assert.notEqual(old.exitCode, null); assert.equal(old.connected, false); assert.equal(old.stdout.closed, true); assert.equal(old.stderr.closed, true) }
        const child = spawn(process.execPath, [new URL('./fixtures/diagnostics-runtime-child.mjs', import.meta.url).pathname, root, args[0]], spawnOptions)
        children.push(child); return child
      } }),
    }, client: { async call() { return { content: [{ type: 'text', text: '(セッション無し)' }] } }, async close() { clientCloses++ } },
  })
  t.after(() => runtime.close())
  assert.equal(runtime.services.diagnosticsModule, controller)
  const facade = runtime.services.diagnostics
  assert.notEqual(facade.constructor.name, 'Diagnostics')
  const saved = await facade.record({ code: 'SERVER_HTTP_503', module: 'server', diagnostic_log: 'retained original' })
  assert.equal(saved.occurrence_count, 1)
  await facade.setStatus(saved.fingerprint, 'resolved', { note: 'retained note' })
  const admin = createDiagnosticsAdminServer({ diagnostics: facade, key: 'fixture-key' }); admin.listen(0, '127.0.0.1'); await once(admin, 'listening')
  t.after(() => new Promise(resolve => admin.close(resolve)))
  const adminGet = authorization => fetch(`http://127.0.0.1:${admin.address().port}/api/admin/logs`, { headers: { authorization } })
  assert.equal((await adminGet('invalid')).status, 401)
  assert.equal((await adminGet('Bearer fixture-key')).status, 200)
  await runtime.start()
  const parent = process.pid, port = runtime.gateway.address.port
  const request = async (path, body) => {
    const reply = await fetch(`http://127.0.0.1:${port}/api/updates${path}`, body ? { method: 'POST', body: JSON.stringify(body) } : {})
    const value = await reply.json(); assert.ok(reply.ok, JSON.stringify(value)); return value
  }
  const run = async input => {
    const { plan } = await request('/plans', input), requestId = randomUUID()
    await request('/operations', { planId: plan.planId, requestId, confirmContainerRestart: false })
    for (let attempt = 0; attempt < 200; attempt++) {
      const { operation } = await request('/operations/' + requestId)
      if (['completed', 'failed', 'unknown'].includes(operation.phase)) { assert.equal(operation.phase, 'completed', JSON.stringify(operation)); return }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.fail('diagnostics fixture did not reach a confirmed result')
  }
  await run({ scope: 'component', componentId: 'diagnostics' })
  assert.equal(controller.snapshot().currentVersionId, versions[0])
  assert.equal(runtime.services.diagnostics, facade)
  activeVersion = versions[1]
  await run({ scope: 'component', componentId: 'diagnostics' })
  await run({ scope: 'component', componentId: 'diagnostics', action: 'rollback' })
  assert.equal(controller.snapshot().currentVersionId, versions[0])
  const row = (await facade.list()).find(value => value.fingerprint === saved.fingerprint)
  assert.equal(row.diagnostic_log, 'retained original'); assert.equal(row.status, 'resolved'); assert.equal(row.occurrence_count, 1)
  assert.equal(row.diagnostic_context.investigation_note.summary, 'retained note')
  assert.equal(process.pid, parent); assert.equal(runtime.gateway.address.port, port); assert.equal(clientCloses, 0)
  const inventory = await request('')
  assert.equal(inventory.components.find(value => value.id === 'diagnostics').current.digest, 'sha256:' + versions[0])
  await runtime.close(); assert.equal(clientCloses, 1)
  const unavailable = await adminGet('Bearer fixture-key')
  assert.equal(unavailable.status, 503); assert.deepEqual(await unavailable.json(), { error: 'DIAGNOSTICS_UNAVAILABLE' })
  for (const child of children) assert.equal(child.exitCode, 0)
  const disk = JSON.parse(await readFile(join(root, 'logs/diagnostics.json')))
  assert.equal(disk.find(value => value.fingerprint === saved.fingerprint).diagnostic_log, 'retained original')
})

test('diagnostics startup failure closes the owned controller and keeps the original error', async t => {
  const initial = await bootstrap(t), failure = new Error('synthetic initialization failure')
  let closes = 0
  await assert.rejects(createApplicationServices({ ...initial, environment: {},
    createDiagnosticsProcess: () => ({ start: async () => { throw failure }, close: async () => { closes++ } }),
  }), error => error === failure)
  assert.equal(closes, 1)
})
