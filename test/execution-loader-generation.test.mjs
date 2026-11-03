import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createExecutionFactoryLoader } from '../src/execution-loader.mjs'
import * as builtin from '../src/execution-dispatcher.mjs'
import { createExecutionGeneration } from '../src/execution-generation.mjs'
import { createExecutionFacade } from '../src/execution-facade.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'
import { writeAtomic } from '../src/json-file.mjs'

// Runtime I/O ports are synthetic; reader selection, engine code and caller wiring are real.
test('verified reader interface drives different real engine bundles through generation, stable facade and parent selection ACK', async t => {
  const root = await mkdtemp(join(tmpdir(), 'execution-loader-generation-')); t.after(() => rm(root, { recursive: true, force: true }))
  const signedRoot = join(root, 'signed'), versionId = 'a'.repeat(64), sourceCommit = 'b'.repeat(40)
  await mkdir(signedRoot)
  await cp(fileURLToPath(new URL('../src', import.meta.url)), join(signedRoot, 'src'), { recursive: true })
  await symlink(await realpath(new URL('../node_modules', import.meta.url)), join(signedRoot, 'node_modules'), 'dir')
  const business = join(signedRoot, 'src/bot-administration.mjs'), before = await readFile(business, 'utf8')
  assert.ok(before.includes('return { ...bot,'))
  await writeFile(business, before.replace('return { ...bot,', "return { fixtureEngine: 'signed', ...bot,"))
  const imports = [], platform = { os: process.platform, arch: { x64: 'amd64', arm64: 'arm64' }[process.arch] }
  const expectedRelease = { componentId: 'execution', versionId, sourceCommit, platform, changes: [],
    artifact: { kind: 'archive', archive: { sha256: versionId } },
    compatibility: { nodeMajor: 26, parentProtocol: 1, stateSchema: null, containerUpdate: null,
      stateCompatibility: builtin.EXECUTION_STATE_COMPATIBILITY } }
  const loadFactory = createExecutionFactoryLoader({ builtinIdentity: async () => sourceCommit,
    prepareRelease: async version => {
      assert.equal(version, versionId)
      return { versionId, sourceCommit, appRoot: `/run/bellteam-maintenance/execution/releases/${versionId}/payload`,
        protocolVersion: 1, platform, stateCompatibility: builtin.EXECUTION_STATE_COMPATIBILITY }
    },
    importFactory: async url => {
      imports.push(url)
      if (url === 'file:///app/src/execution-dispatcher.mjs') return builtin
      assert.equal(url, `file:///run/bellteam-maintenance/execution/releases/${versionId}/payload/src/execution-dispatcher.mjs`)
      return import(pathToFileURL(join(signedRoot, 'src/execution-dispatcher.mjs')).href)
    },
  })
  const bot = { id: 'bot-synthetic', session: 'synthetic', harness: 'codex' }, membersAdmission = new MembersAdmission()
  let nativeCloses = 0, ack, reached
  const ackPromise = new Promise(resolve => { ack = resolve }), saved = new Promise(resolve => { reached = resolve })
  const native = { async call(name) { assert.equal(name, 'pty_list'); return {} }, async close() { nativeCloses++ } }
  const selection = join(root, 'selection.json')
  const controller = createExecutionGeneration({ loadFactory,
    ports: { native, bots: new Map([[bot.id, bot]]), rooms: {}, membersAdmission, access: { assertWorkAllowed() {} }, observer: { report() {} },
      configurationStorage: { root: join(root, 'intents'), ownerUid: process.getuid() } },
    onAdopt: async value => { await writeAtomic(selection, value); reached(); await ackPromise },
  })
  t.after(() => controller.close())
  const facade = createExecutionFacade({ getController: () => controller, client: native, membersAdmission, requestStop() {}, watchQueue: () => () => {} })
  const stableView = facade.administration.view
  await controller.start()
  assert.equal(stableView(bot).fixtureEngine, undefined)
  const update = controller.reserve(versionId, { expectedRelease }); update.start(); await saved
  assert.throws(() => stableView(bot), { code: 'EXECUTION_NOT_ACCEPTING' })
  ack(); await update.completion
  assert.equal(controller.snapshot().update.status, 'succeeded')
  assert.equal(stableView(bot).fixtureEngine, 'signed')
  assert.deepEqual(JSON.parse(await readFile(selection, 'utf8')), { currentVersionId: versionId, previousVersionId: null })
  await controller.replace('builtin')
  assert.equal(stableView(bot).fixtureEngine, undefined)
  assert.deepEqual(JSON.parse(await readFile(selection, 'utf8')), { currentVersionId: null, previousVersionId: versionId })
  assert.equal(nativeCloses, 0)
  assert.ok(imports.includes(`file:///run/bellteam-maintenance/execution/releases/${versionId}/payload/src/execution-dispatcher.mjs`))
})
