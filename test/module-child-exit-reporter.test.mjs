import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { createModuleChildExitReporter } from '../src/module-child-exit-reporter.mjs'
import { Diagnostics } from '../src/diagnostics.mjs'
import { createUsageAssembly } from '../src/usage-assembly.mjs'
import { createConversationAssembly } from '../src/conversation-assembly.mjs'
import { createMembersAssembly } from '../src/members-assembly.mjs'
import { createNotifications } from '../src/usage/notifications.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'
const dto = (component = 'usage', bytes = 1) => ({ schema: 'bellteam.module-child-exit.v1', component, exitCode: 1, signal: null,
  reason: 'unknown', stderrBytes: bytes, stderrCodes: [], stderrTruncated: false, stderrTail: [] })

test('bootstrap exits retain only six latest reports and flush through the real sole diagnostics writer after ready', async t => {
  const root = await mkdtemp(join(tmpdir(), 'module-exit-reporter-')); t.after(() => rm(root, { recursive: true, force: true }))
  const reporter = createModuleChildExitReporter(), diagnostics = new Diagnostics(join(root, 'diagnostics.json'))
  for (const component of ['conversation', 'usage', 'diagnostics', 'members', 'notifications', 'web-gateway']) {
    reporter.observe(dto(component)); reporter.observe(dto(component, 2))
  }
  assert.throws(() => reporter.observe({ ...dto(), private: 'not accepted' }))
  await diagnostics.initialize(); reporter.attach(diagnostics, false)
  assert.equal(diagnostics.list().length, 0)
  reporter.ready(true); await reporter.close()
  const restored = new Diagnostics(join(root, 'diagnostics.json')); await restored.initialize()
  const rows = restored.list()
  assert.equal(rows.length, 6)
  assert.ok(rows.every(row => row.occurrence_count === 1 && JSON.parse(row.diagnostic_log).stderrBytes === 2))
})

test('a saving acknowledgement cannot delete a later same-component exit and close waits for both', async () => {
  const reporter = createModuleChildExitReporter(), calls = [], releases = []
  reporter.attach({ record(report) { calls.push(JSON.parse(report.diagnostic_log)); return new Promise(resolve => releases.push(resolve)) } }, true)
  reporter.observe(dto('usage', 1)); await setImmediate()
  reporter.observe(dto('usage', 2)); await setImmediate(); assert.equal(calls.length, 1)
  releases.shift()(); await setImmediate()
  assert.deepEqual(calls.map(value => value.stderrBytes), [1, 2])
  const closed = reporter.close(); releases.shift()(); await closed
  reporter.observe(dto('usage', 3)); await setImmediate(); assert.equal(calls.length, 2)
})

test('only definite not-accepted reports retry on a later ready transition; unknown never re-records', async () => {
  for (const outcome of ['not_accepted', 'unknown']) {
    let calls = 0
    const reporter = createModuleChildExitReporter()
    reporter.attach({ record() { calls++; if (calls === 1) throw Object.assign(Error(outcome), { outcome }) } }, true)
    reporter.observe(dto()); await setImmediate(); reporter.ready(true); await setImmediate()
    assert.equal(calls, 1)
    reporter.ready(false); reporter.ready(true); await setImmediate()
    assert.equal(calls, outcome === 'not_accepted' ? 2 : 1)
    await reporter.close()
  }
})

test('parent assemblies forward the exact observation callback into the existing four factories', () => {
  const observed = [], onModuleChildExit = value => observed.push(value)
  const createProcess = options => { options.onModuleChildExit(dto()); return {} }
  createUsageAssembly({ root: '/unused', getServices: () => ({}), onModuleChildExit, createProcess })
  createConversationAssembly({ root: '/unused', membersAdmission: new MembersAdmission(), getServices: () => ({}), onModuleChildExit, createProcess })
  createMembersAssembly({ root: '/unused', membersAdmission: new MembersAdmission(), dependencies: () => ({}), onModuleChildExit, createProcess })
  createNotifications({ root: '/unused', onModuleChildExit, createProcess })
  assert.equal(observed.length, 4)
})

test('normal runtime wires diagnostics and gateway observations into the same writer', async t => {
  const { mock } = await import('node:test')
  if (!mock.module) { t.skip('requires --experimental-test-module-mocks'); return }
  const records = []
  mock.module(new URL('../src/http-gateway-process.mjs', import.meta.url).href, { namedExports: {
    createHttpGatewayProcess: options => ({ async start() { options.onModuleChildExit(dto('web-gateway')) }, async close() {}, address: { port: 0 }, snapshot: () => ({ available: true }) }),
  } })
  const { createApplicationRuntime } = await import('../src/application-runtime.mjs')
  const { BotRegistry } = await import('../src/bot-registry.mjs')
  const { FeatureSettings } = await import('../src/feature-settings.mjs')
  const { OwnerProfile } = await import('../src/owner-profile.mjs')
  const { UserRules } = await import('../src/user-rules.mjs')
  const { createSyntheticNotificationsProcess } = await import('./helpers/notifications-process.mjs')
  const { writeFile } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'module-exit-runtime-')); t.after(() => rm(root, { recursive: true, force: true }))
  const seedPath = join(root, 'seed.json'); await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [] }))
  const bots = new BotRegistry({ seedPath, botsRoot: join(root, 'bots') }), settings = new FeatureSettings({ root, environment: {} }), ownerProfile = new OwnerProfile({ root }), userRules = new UserRules({ root })
  for (const item of [bots, settings, ownerProfile, userRules]) await item.initialize()
  const runtime = await createApplicationRuntime({ root, appRoot: new URL('../', import.meta.url).pathname, home: join(root, 'home'), environment: { BELLTEAM_WEB_PORT: '0', BELLTEAM_INTERNAL_PORT: '0' }, client: { async call() { return {} }, async close() {} },
    bootstrap: { bots, settings, ownerProfile, userRules, aiterm: { command: 'synthetic' }, refreshGlobalInstructions: async () => {}, olrwManagement: null,
      createNotificationsProcess: createSyntheticNotificationsProcess,
      createDiagnosticsProcess: options => {
        options.onModuleChildExit(dto('diagnostics'))
        return { async start() { options.onState({ available: true }) }, snapshot: () => ({ available: true }), async request(method, params) { if (method === 'record') records.push(params.report); return {} }, async close() {} }
      },
    },
  })
  t.after(() => runtime.close())
  await runtime.start(); await setImmediate(); await runtime.close()
  assert.deepEqual(records.filter(report => report.code === 'SERVER_MODULE_CHILD_EXITED').map(report => JSON.parse(report.diagnostic_log).component).sort(), ['diagnostics', 'web-gateway'])
})

test('child exit origin rides the stored DTO, and an older diagnostics refusal refiles it once without the origin (I-5)', async () => {
  const { reportModuleChildExit } = await import('../src/module-child-restart.mjs')
  const { validateModuleChildExitDiagnostic } = await import('../src/diagnostics.mjs')
  const observation = { stderrCodes: [], reason: 'unknown', stderrBytes: 107, stderrTruncated: false, stderrTail: [],
    childExitOrigin: { origin: 'exit_control', failureCode: null } }
  let dto; reportModuleChildExit('conversation', { code: 0, signal: null }, observation, value => { dto = value })
  assert.deepEqual(dto.childExitOrigin, { origin: 'exit_control', failureCode: null })
  assert.equal(validateModuleChildExitDiagnostic(dto), true)
  assert.equal(validateModuleChildExitDiagnostic({ ...dto, childExitOrigin: { origin: 'text', failureCode: null } }), false)
  assert.equal(validateModuleChildExitDiagnostic({ ...dto, childExitOrigin: { origin: 'peer_failure', failureCode: 'secret text' } }), false)
  const saved = [], reporter = createModuleChildExitReporter()
  reporter.attach({ record: async report => {
    if (report.diagnostic_log.includes('childExitOrigin')) throw Object.assign(new Error('DIAGNOSTIC_INVALID'), { code: 'DIAGNOSTIC_INVALID' })
    saved.push(JSON.parse(report.diagnostic_log))
  } }, true)
  reporter.observe(dto)
  for (let i = 0; i < 5; i++) await setImmediate()
  assert.equal(saved.length, 1); assert.equal(saved[0].childExitOrigin, undefined); assert.equal(saved[0].exitCode, 0)
})
