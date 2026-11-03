import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createExecutionFactoryLoader } from '../src/execution-loader.mjs'
import { validateExecutionReleaseManifest, prepareExecutionRelease } from '../src/web-gateway-release.mjs'

const sha = 'a'.repeat(64), sourceCommit = 'b'.repeat(40), state = 'bellteam.execution-state.v1'
const platform = { os: process.platform, arch: ({ x64: 'amd64', arm64: 'arm64' })[process.arch] }
const builtinFactory = () => ({ kind: 'builtin' }), signedFactory = () => ({ kind: 'signed' })
const namespace = factory => ({ EXECUTION_STATE_COMPATIBILITY: state, createExecutionDispatcher: factory })
const descriptor = () => ({ versionId: sha, sourceCommit, appRoot: `/run/bellteam-maintenance/execution/releases/${sha}/payload`,
  protocolVersion: 1, platform, stateCompatibility: state })
const catalog = () => ({ componentId: 'execution', versionId: sha, sourceCommit, platform,
  artifact: { kind: 'archive', archive: { sha256: sha } }, changes: [],
  compatibility: { nodeMajor: 26, parentProtocol: 1, stateSchema: null, containerUpdate: null, stateCompatibility: state } })
function fixture(change = {}) {
  const imports = [], prepared = []
  const load = createExecutionFactoryLoader({
    builtinIdentity: async () => sourceCommit,
    prepareRelease: async versionId => { prepared.push(versionId); return descriptor() },
    importFactory: async url => { imports.push(url); return namespace(imports.length === 1 ? builtinFactory : signedFactory) },
    ...change,
  })
  return { load, imports, prepared }
}

test('builtin factory comes from this image and its identity reader without any archive read', async () => {
  const f = fixture(), result = await f.load()
  assert.equal(result.versionId, null); assert.equal(result.sourceCommit, sourceCommit)
  assert.equal(result.createExecutionDispatcher, builtinFactory); assert.equal(Object.isFrozen(result), true)
  assert.equal(f.prepared.length, 0)
  assert.equal(f.imports[0], 'file:///app/src/execution-dispatcher.mjs')
})
test('signed factory imports only the authenticated fixed root after catalog and compatibility match', async () => {
  const f = fixture(), result = await f.load(sha, { expectedRelease: catalog() })
  assert.deepEqual(f.prepared, [sha])
  assert.equal(f.imports[1], `file:///run/bellteam-maintenance/execution/releases/${sha}/payload/src/execution-dispatcher.mjs`)
  assert.equal(result.createExecutionDispatcher, signedFactory)
})
test('arbitrary paths, foreign roots and incompatible content never reach the selected factory import', async () => {
  for (const versionId of ['builtin', '../x', 'https://example.com/engine.mjs', 'A'.repeat(64)]) {
    const f = fixture(); await assert.rejects(f.load(versionId), /VERSION_INVALID/)
    assert.equal(f.imports.length, 0)
  }
  for (const mutate of [d => { d.appRoot = '/tmp/factory' }, d => { d.platform = { os: 'other', arch: 'amd64' } },
    d => { d.stateCompatibility = 'other' }, d => { d.sourceCommit = 'unknown' }]) {
    const f = fixture({ prepareRelease: async () => { const value = descriptor(); mutate(value); return value } })
    await assert.rejects(f.load(sha), /RELEASE_INVALID/)
    assert.equal(f.imports.length, 1)
  }
})
test('catalog mismatch and absent builtin identity fail closed without instantiating any engine', async () => {
  const f = fixture(), expected = catalog(); expected.sourceCommit = 'c'.repeat(40)
  await assert.rejects(f.load(sha, { expectedRelease: expected }), /CATALOG_INCOMPATIBLE/)
  assert.equal(f.imports.length, 1)
  await assert.rejects(fixture({ builtinIdentity: async () => null }).load(), /BUILTIN_IDENTITY_INVALID/)
  await assert.rejects(fixture().load(null, { expectedRelease: catalog() }), /BUILTIN_EXPECTATION_INVALID/)
})
test('namespace validation rejects a missing factory or a different runtime state value', async () => {
  await assert.rejects(fixture({ importFactory: async () => ({ EXECUTION_STATE_COMPATIBILITY: state }) }).load(), /FACTORY_INVALID/)
  let calls = 0
  const f = fixture({ importFactory: async () => ++calls === 1 ? namespace(builtinFactory)
    : { ...namespace(signedFactory), EXECUTION_STATE_COMPATIBILITY: 'other' } })
  await assert.rejects(f.load(sha), /STATE_INCOMPATIBLE/)
})
test('execution artifact uses the business exported state value and same-bundle relative engine entry', () => {
  const manifest = { schema: 'bellteam.execution.artifact.v1', component: 'execution', sourceCommit,
    entry: 'payload/src/execution-dispatcher.mjs',
    runtime: { ...platform, nodeMajor: 26, parentProtocol: 1, stateCompatibility: state },
    files: ['src/execution-dispatcher.mjs', 'src/aiterm-transport.mjs', 'src/configuration-intents.mjs', 'config/common-agents.md', 'package.json', 'package-lock.json']
      .map(path => ({ path: 'payload/' + path, bytes: 1, sha256: sha })),
  }
  assert.equal(validateExecutionReleaseManifest(manifest, state), manifest)
  assert.throws(() => validateExecutionReleaseManifest(manifest, 'other'), /STATE_INCOMPATIBLE/)
  const wrong = structuredClone(manifest); wrong.files.pop()
  assert.throws(() => validateExecutionReleaseManifest(wrong, state), /INVENTORY_INVALID/)
  const missingReminder = structuredClone(manifest)
  missingReminder.files = missingReminder.files.filter(file => file.path !== 'payload/config/common-agents.md')
  assert.throws(() => validateExecutionReleaseManifest(missingReminder, state), /INVENTORY_INVALID/)
})

test('invalid and cancelled installed reads stop before importing the builtin business module', async () => {
  await assert.rejects(prepareExecutionRelease('../x'), /VERSION_INVALID/)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(prepareExecutionRelease(sha, { signal: abort.signal }), { name: 'AbortError' })
})

test('execution loader imports without uninstalled usage and diagnostics business modules', async t => {
  const root = await mkdtemp(join(tmpdir(), 'execution-loader-base-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const folder of ['', 'members', 'memory']) await mkdir(join(root, 'src', folder), { recursive: true })
  for (const name of ['execution-loader.mjs', 'web-gateway-release.mjs', 'module-release.mjs',
    'members/state-compatibility.mjs', 'memory/state-compatibility.mjs', 'memory-search.mjs'])
    await copyFile(new URL('../src/' + name, import.meta.url), join(root, 'src', name))
  const source = `import {createExecutionFactoryLoader} from ${JSON.stringify(pathToFileURL(join(root, 'src/execution-loader.mjs')).href)};
import {validateModuleReleaseManifest} from ${JSON.stringify(pathToFileURL(join(root, 'src/module-release.mjs')).href)};
const load=createExecutionFactoryLoader({builtinIdentity:async()=>${JSON.stringify(sourceCommit)},importFactory:async()=>({EXECUTION_STATE_COMPATIBILITY:${JSON.stringify(state)},createExecutionDispatcher:()=>({})})});
const result=await load();if(result.sourceCommit!==${JSON.stringify(sourceCommit)})throw new Error('identity');
try{validateModuleReleaseManifest('other',{})}catch(error){if(error.code!=='MODULE_RELEASE_COMPONENT_INVALID')throw error}
console.log('loaded');`
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { env: {} })
  assert.equal(result.stdout.trim(), 'loaded')
})
