import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { createConversationPreservationFixture } from './helpers/conversation-preservation.mjs'

const appRoot = process.env.CONVERSATION_FIXTURE_APP_ROOT ?? fileURLToPath(new URL('../', import.meta.url))
const load = path => import(pathToFileURL(join(appRoot, path)))

test('seed and six-file fingerprint work as UID1001 below a UID1000 mode0711 managed root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-managed-'))
  const child = String.raw`
    import assert from 'node:assert/strict'
    import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
    import { join } from 'node:path'
    const [root, appRoot, helper] = process.argv.slice(1)
    assert.equal(process.getuid(), 1001); assert.equal(process.getgid(), 1001)
    await assert.rejects(readdir(root), { code: 'EACCES' })
    await assert.rejects(writeFile(join(root, 'forbidden'), ''), { code: 'EACCES' })
    const { createConversationPreservationFixture } = await import(helper)
    const fixture = await createConversationPreservationFixture({ root, appRoot })
    assert.equal(fixture.seedPath, join(root, 'state/conversation-fixture-seed.json'))
    const snapshot = await fixture.snapshot(), seed = await stat(fixture.seedPath)
    assert.equal(Object.keys(snapshot).length, 6)
    assert(Object.hasOwn(snapshot, 'state/conversation-fixture-seed.json'))
    assert(!Object.hasOwn(snapshot, 'conversation-fixture-seed.json'))
    assert.equal(JSON.parse(await readFile(fixture.seedPath, 'utf8')).bots[0].id, fixture.botId)
    assert.deepEqual([seed.uid, seed.gid, seed.mode & 0o777], [1001, 1001, 0o600])
    console.log(JSON.stringify({ uid: process.getuid(), fingerprintFiles: 6, seedMode: seed.mode & 0o777 }))
  `
  const managed = String.raw`
    import assert from 'node:assert/strict'
    import { execFileSync } from 'node:child_process'
    import { chmod, chown, mkdir, rm, stat } from 'node:fs/promises'
    import { join } from 'node:path'
    const [root, appRoot, helper, child] = process.argv.slice(1)
    try {
      await chown(root, 1000, 1000); await chmod(root, 0o711)
      for (const name of ['logs', 'rooms', 'state']) {
        const path = join(root, name)
        await mkdir(path, { mode: 0o700 }); await chown(path, 1001, 1001)
      }
      const before = await stat(root, { bigint: true })
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', child, root, appRoot, helper],
        { uid: 1001, gid: 1001, encoding: 'utf8', timeout: 10000 })
      const after = await stat(root, { bigint: true })
      assert.deepEqual([after.uid, after.gid, after.mode & 0o777n, after.mtimeNs], [1000n, 1000n, 0o711n, before.mtimeNs])
      process.stdout.write(output)
    } finally { await rm(root, { recursive: true, force: true }) }
  `
  const args = ['--input-type=module', '-e', managed, root, appRoot, new URL('./helpers/conversation-preservation.mjs', import.meta.url).href, child]
  const output = process.getuid() === 0 ? execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 })
    : execFileSync('sudo', ['-n', process.execPath, ...args], { encoding: 'utf8', timeout: 15000 })
  assert.deepEqual(JSON.parse(output), { uid: 1001, fingerprintFiles: 6, seedMode: 0o600 })
})

test('observer fixture delegates later native lifetime work with the same params and parent context', async t => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-preservation-native-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await createConversationPreservationFixture({ root, appRoot })
  const context = Object.freeze({ rootMethod: 'user.turn', operationContext: Object.freeze({}) })
  const params = Object.freeze({ marker: 'same synthetic params' }), result = Object.freeze({ marker: 'same result' })
  const methods = ['execution.turn', 'execution.report', 'execution.background.begin', 'execution.background.end', 'members.profiles.read']
  const seen = []
  const effect = fixture.wrapEffects((method, input, parent) => {
    assert.equal(input, params); assert.equal(parent, context); seen.push(method); return result
  })
  for (const method of methods) assert.equal(await effect(method, params, context), result)
  assert.deepEqual(seen, methods)
  assert.equal(fixture.counts().native, 3)
})

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
