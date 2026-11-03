import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { createConversationPreservationFixture } from './helpers/conversation-preservation.mjs'

const appRoot = process.env.CONVERSATION_FIXTURE_APP_ROOT ?? fileURLToPath(new URL('../', import.meta.url))
const load = path => import(pathToFileURL(join(appRoot, path)))

test('business helper uses the default parent runtime across builtin, substituted SHA and builtin without restoring old state', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-preservation-')), children = [], nativeCalls = []
  const backgroundHeld = Promise.withResolvers(), releaseBackground = Promise.withResolvers()
  let holdBackground = false, heldContext = null
  t.after(() => releaseBackground.resolve())
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await createConversationPreservationFixture({ root, appRoot })
  const [{ createApplicationRuntime }, { createConversationAssembly }, { createConversationProcess }, { FeatureSettings },
    { BotRegistry }, { OwnerProfile }, { UserRules }, { createSyntheticNotificationsProcess }] = await Promise.all([
    load('src/application-runtime.mjs'), load('src/conversation-assembly.mjs'), load('src/conversation-process.mjs'),
    load('src/feature-settings.mjs'), load('src/bot-registry.mjs'), load('src/owner-profile.mjs'), load('src/user-rules.mjs'),
    load('test/helpers/notifications-process.mjs'),
  ])
  await mkdir(join(root, 'state'))
  const bots = new BotRegistry({ seedPath: fixture.seedPath, botsRoot: join(root, 'bots') })
  const settings = new FeatureSettings({ root, environment: {} }), ownerProfile = new OwnerProfile({ root }), userRules = new UserRules({ root })
  for (const value of [bots, settings, ownerProfile, userRules]) await value.initialize()
  const runtime = await createApplicationRuntime({ root, appRoot, home: join(root, 'home'),
    environment: { BELLTEAM_WEB_PORT: '0', BELLTEAM_INTERNAL_PORT: '0' },
    client: { async call(...args) { nativeCalls.push(args); return { content: [{ type: 'text', text: '(セッション無し)' }] } }, async close() {} },
    bootstrap: { bots, settings, ownerProfile, userRules, refreshGlobalInstructions: async () => {}, aiterm: { command: 'synthetic', args: [] },
      createNotificationsProcess: createSyntheticNotificationsProcess,
      createConversationAssembly: options => createConversationAssembly({ ...options,
        createProcess: ports => {
          const effect = fixture.wrapEffects(ports.onEffect)
          return createConversationProcess({ ...ports, onEffect: async (method, params, context) => {
            const result = await effect(method, params, context)
            if (holdBackground && method === 'runtime.observer.check' && result.results[0].status === 'unchanged') {
              heldContext = context; backgroundHeld.resolve(); await releaseBackground.promise; holdBackground = false
            } else if (heldContext && context !== heldContext && method === 'members.profiles.read' && context.rootMethod === 'observation.poll') {
              setTimeout(() => releaseBackground.resolve(), 50)
            }
            return result
          } })
        },
        prepareRelease: async versionId => ({ versionId, appRoot: `/run/bellteam-maintenance/conversation/releases/${versionId}/payload` }),
        spawnProcess: (_entry, args, options) => {
          for (const child of children) assert(child.exitCode !== null && !child.connected && child.stdout.closed && child.stderr.closed)
          const child = spawn(process.execPath, [join(appRoot, 'test/fixtures/conversation-channel-child.mjs'), root, args[0]], options)
          children.push(child); return child
        } }),
    } })
  t.after(() => runtime.close())
  await runtime.start()
  const controller = runtime.services.conversationAssembly.controller, parentPid = process.pid
  await fixture.exercise({ runtime, label: 'before', versionId: 'builtin' })
  holdBackground = true
  await backgroundHeld.promise
  const overlap = await fixture.exercise({ runtime, label: 'during-background', versionId: 'builtin' })
  assert.equal(overlap.manualAttempts, 2)
  const sha = 'a'.repeat(64)
  await controller.replace(sha)
  await fixture.exercise({ runtime, label: 'signed-substitution', versionId: sha })
  await controller.replace('builtin')
  await fixture.exercise({ runtime, label: 'restored', versionId: 'builtin' })
  assert.deepEqual(fixture.receipts.map(row => [row.historyRows, row.cursor]), [[4, 'fixture-cursor-1'], [6, 'fixture-cursor-2'], [8, 'fixture-cursor-3'], [10, 'fixture-cursor-4']])
  assert.equal(process.pid, parentPid); assert.equal(children.length, 3); assert.deepEqual(nativeCalls, [])
  assert(fixture.counts().backgroundPolls >= 2)
  const counts = fixture.counts()
  await appendFile(join(root, 'logs/self-turns.json'), ' ')
  await assert.rejects(fixture.exercise({ runtime, label: 'tampered', versionId: 'builtin' }), /latest business state/u)
  assert.deepEqual(fixture.counts(), counts)
  await assert.rejects(fixture.exercise({ runtime, label: 'wrong-version', versionId: sha }))
  await assert.rejects(fixture.exercise({ runtime, label: 'before', versionId: 'builtin' }), /unique/u)
})
