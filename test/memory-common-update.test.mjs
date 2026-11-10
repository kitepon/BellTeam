import { createFixtureJobClient } from './fixtures/update-job-client.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createMemoryProcess } from '../src/memory-process.mjs'
import { MEMORY_STATE_COMPATIBILITY } from '../src/memory/state-compatibility.mjs'
import { createModuleUpdateAdapters } from '../src/update-module-adapters.mjs'
import { createModuleUpdateCatalog, moduleReleaseCompatible } from '../src/update-module-catalog.mjs'
import { createModuleUpdateExecutor } from '../src/update-module-executor.mjs'
import { createUpdateCenter } from '../src/update-center.mjs'
import { validateUpdates } from '../src/update-center-contract.mjs'

const versionId = 'c'.repeat(64), sourceCommit = 'b'.repeat(40)
const selected = () => {
  const url = `https://github.com/kitepon/BellTeam/releases/download/updates-20261103T000000Z/memory-${sourceCommit}-linux-amd64.tar.gz`
  return { schema: 'bellteam.update-catalog.selection.v1', catalogSha256: 'd'.repeat(64), publishedAt: '2026-11-03T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
    publication: { status: 'verified', checkedAt: '2026-11-03T00:00:00Z', error: null },
    release: { componentId: 'memory', sourceCommit, versionId, platform: { os: 'linux', arch: 'amd64' }, changes: ['記憶の更新'],
      compatibility: { nodeMajor: 26, parentProtocol: 1, stateSchema: null, containerUpdate: null, stateCompatibility: MEMORY_STATE_COMPATIBILITY },
      artifact: { kind: 'archive', archive: { url, sha256: versionId, bytes: 1000 }, bundle: { url: url + '.sigstore.json', sha256: 'e'.repeat(64), bytes: 100 }, signerCommit: sourceCommit } } }
}

test('memory catalog accepts only the actual seven fields and never derives a builtin version from another module', async () => {
  const catalog = createModuleUpdateCatalog({ client: { catalog: async () => selected() } })
  const state = await createUpdateCenter({ moduleCatalog: catalog, memory: { snapshot: () => ({ available: true, currentVersionId: null, generation: 'real-generation' }) },
    notifications: { controller: { snapshot: () => ({ builtinSourceCommit: 'a'.repeat(40) }) } } }).snapshot()
  const memory = state.components.find(component => component.id === 'memory')
  assert.equal(memory.current, null); assert.equal(memory.availability.available, true); assert.equal(memory.published.version, versionId)
  assert.equal(validateUpdates(state).valid, true)
  // A different value is a release for another body: well formed, decided as incompatible (module-process.md).
  const other = structuredClone(selected()); other.release.compatibility.stateCompatibility.searchIndexVersion = 'different-icu'
  assert.equal((await createModuleUpdateCatalog({ client: { catalog: async () => other } }).select('memory')).release.versionId, versionId)
  assert.equal(moduleReleaseCompatible('memory', other.release), false)
  for (const mutate of [value => { delete value.release.compatibility.stateCompatibility.searchIndexVersion },
    value => { value.release.compatibility.stateCompatibility.extra = true }]) {
    const bad = structuredClone(selected()); mutate(bad)
    const invalid = createModuleUpdateCatalog({ client: { catalog: async () => bad } })
    await assert.rejects(invalid.select('memory'), { code: 'UPDATE_MODULE_CATALOG_INVALID' })
  }
})

test('one memory controller and its actual generation drive the stable facade, durable ledger, availability and close', async t => {
  const root = await mkdtemp(join(tmpdir(), 'memory-common-')); await mkdir(join(root, 'state'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const requests = [], prepareCalls = []
  const prepare = async (id, options) => { prepareCalls.push(options.expectedRelease); return { versionId: id, sourceCommit, appRoot: `/run/bellteam-memory-code/${id}/payload`, protocolVersion: 1, stateCompatibility: MEMORY_STATE_COMPATIBILITY } }
  const memory = createMemoryProcess({ root, prepareRelease: prepare, run: async (command, args, options) => {
    const request = JSON.parse(options.input); requests.push(request)
    return { stdout: JSON.stringify({ protocolVersion: 1, generation: request.generation, stateCompatibility: MEMORY_STATE_COMPATIBILITY,
      result: request.method === null ? { restored: true } : { requested: request.method } }) }
  } })
  t.after(() => memory.close())
  await memory.start(); const oldGeneration = memory.snapshot().generation
  const facade = memory.memory(new Map()), adapters = createModuleUpdateAdapters({ gateway: () => null, memory, prepare: { memory: prepare } })
  const catalog = createModuleUpdateCatalog({ client: { catalog: async id => { assert.equal(id, 'memory'); return selected() } } })
  const executor = await createModuleUpdateExecutor({ root, catalog, moduleHost: createFixtureJobClient(root), adapters: { memory: adapters.memory } })
  const center = createUpdateCenter({ memory, moduleExecutor: executor, moduleCatalog: catalog })
  const before = await center.snapshot(), row = before.components.find(component => component.id === 'memory')
  assert.equal(row.current, null); assert.equal(row.capability.supported, true)
  const plan = await center.plan({ scope: 'component', componentId: 'memory' })
  assert.equal(plan.targets[0].current, null)
  const input = { planId: plan.planId, requestId: randomUUID(), confirmContainerRestart: false }
  await center.start(input); await center.close()
  assert.equal((await center.operation(input.requestId)).phase, 'completed')
  assert.notEqual(memory.snapshot().generation, oldGeneration)
  assert.equal(memory.snapshot().currentVersionId, versionId)
  assert.deepEqual(await facade.recallMemory({ scope: 'shared' }), { requested: 'recallMemory' })
  assert.equal(requests.at(-1).generation, memory.snapshot().generation)
  assert.ok(prepareCalls.every(release => release.versionId === versionId))
  await memory.close(); assert.equal(memory.snapshot().phase, 'closed')
  await assert.rejects(facade.recallMemory({ scope: 'shared' }), { code: 'MEMORY_CLOSED' })
})
