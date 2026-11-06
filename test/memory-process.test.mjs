import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryProcess, MEMORY_READY_PROBE } from '../src/memory-process.mjs'
import { BellTeamMemory } from '../src/memory-service.mjs'
import { MEMORY_STATE_COMPATIBILITY } from '../src/memory/state-compatibility.mjs'
import { validateMemoryReleaseManifest } from '../src/memory-release.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => Promise.withResolvers()
const version = 'a'.repeat(64)
async function fixture(t, hook = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'memory-process-')), calls = []
  await mkdir(join(root, 'state'))
  const controller = createMemoryProcess({ root,
    prepareRelease: async versionId => ({ versionId, appRoot: `/run/bellteam-memory-code/${versionId}/payload`,
      protocolVersion: 1, stateCompatibility: MEMORY_STATE_COMPATIBILITY }),
    run: async (node, args, options) => {
      const request = JSON.parse(options.input), call = { entry: args[0], ...request }
      if (request.method !== 'recallMemory' || request.params?.args?.[0]?.query !== MEMORY_READY_PROBE.args[0].query) calls.push(call)
      const value = await hook(call)
      return { stdout: JSON.stringify({ protocolVersion: 1, generation: request.generation,
        stateCompatibility: MEMORY_STATE_COMPATIBILITY, result: request.method === null ? { restored: true } : value ?? null }) }
    },
  })
  t.after(async () => { await controller.close(); await rm(root, { recursive: true, force: true }) })
  await controller.start()
  return { root, controller, calls }
}

test('source changes only after every old seat result/close and returns to builtin with current data', async t => {
  const held = deferred(), entered = deferred()
  const f = await fixture(t, async request => { if (request.method === 'remember') { entered.resolve(); await held.promise }; return 'same-current-data' })
  const writing = f.controller.request('remember', { args: [{}], profiles: [] }); await entered.promise
  const replacing = f.controller.replace(version)
  while (f.controller.snapshot().phase !== 'draining') await tick()
  assert.equal(f.calls.length, 2)
  await assert.rejects(f.controller.request('recallMemory', { args: [{}], profiles: [] }), { code: 'MEMORY_NOT_ACCEPTED' })
  held.resolve(); assert.equal(await writing, 'same-current-data'); await replacing
  assert.equal(f.controller.snapshot().currentVersionId, version)
  assert.equal(f.calls.at(-1).entry, `/run/bellteam-memory-code/${version}/payload/src/run-memory-runtime.mjs`)
  assert.equal(f.calls.at(-1).method, null, 'restore never invokes business initialize')
  assert.equal(await f.controller.request('recallMemory', { args: [{}], profiles: [] }), 'same-current-data')
  await f.controller.replace('builtin')
  assert.equal(f.controller.snapshot().currentVersionId, null)
  assert.equal(JSON.parse(await readFile(join(f.root, 'state/memory-release.json'), 'utf8')).previousVersionId, version)
})

test('a busy generation resumes old code without aborting or reissuing the old child', async t => {
  const held = deferred(), entered = deferred()
  const f = await fixture(t, async request => { if (request.method === 'remember') { entered.resolve(); await held.promise } })
  const writing = f.controller.request('remember', { args: [{}], profiles: [] }); await entered.promise
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const replacing = f.controller.replace(version), rejected = assert.rejects(replacing, { code: 'MEMORY_BUSY' })
  while (f.controller.snapshot().phase !== 'draining') await tick()
  t.mock.timers.tick(60001); await rejected
  assert.equal(f.controller.snapshot().available, true)
  assert.equal(f.controller.snapshot().currentVersionId, null)
  assert.equal(f.calls.length, 2)
  held.resolve(); await writing
})

test('close waits for the replacement restore child and prevents adoption after shutdown', async t => {
  const held = deferred(), entered = deferred()
  const f = await fixture(t, async request => {
    if (request.entry.startsWith('/run/bellteam-memory-code/')) { entered.resolve(); await held.promise }
  })
  const replacing = f.controller.replace(version), rejected = assert.rejects(replacing, { code: 'MEMORY_CLOSED' })
  await entered.promise
  let closed = false
  const closing = f.controller.close().then(() => { closed = true })
  await tick(); assert.equal(closed, false)
  held.resolve(); await rejected; await closing
  assert.equal(f.controller.snapshot().phase, 'closed')
  await assert.rejects(f.controller.start(), { code: 'MEMORY_CLOSED' })
  await assert.rejects(readFile(join(f.root, 'state/memory-release.json')), { code: 'ENOENT' })
})

test('same-target reservations terminate and snapshot callers cannot change the internal update', async t => {
  const f = await fixture(t), reservation = f.controller.reserve('builtin')
  f.controller.snapshot().update.status = 'forged'
  assert.equal(f.controller.snapshot().update.status, 'accepted')
  reservation.start()
  while (f.controller.snapshot().update.status === 'running') await tick()
  assert.equal(f.controller.snapshot().update.status, 'succeeded')
  assert.equal(f.calls.length, 1)
})

test('a mismatched result generation fails only that memory request', async t => {
  const f = await fixture(t)
  // Use the real runner response guard with a second isolated controller.
  const controller = createMemoryProcess({ root: f.root, run: async (_node, _args, options) => {
    const request = JSON.parse(options.input)
    return { stdout: JSON.stringify({ protocolVersion: 1, generation: request.method === null || request.params?.args?.[0]?.query === MEMORY_READY_PROBE.args[0].query ? request.generation : 'wrong',
      stateCompatibility: MEMORY_STATE_COMPATIBILITY, result: request.method === null ? { restored: true } : null }) }
  } })
  t.after(() => controller.close())
  await assert.rejects(controller.request('recallMemory', { args: [{}], profiles: [] }), { code: 'MEMORY_RESULT_UNCONFIRMED', outcome: 'unknown' })
  assert.equal(controller.snapshot().available, true)
  await assert.rejects(controller.request('remember', { args: [{}], profiles: [] }), { code: 'MEMORY_RESULT_UNCONFIRMED' })
})

test('memory artifact uses exact real storage/ICU compatibility and requires the selected entry closure', () => {
  const manifest = { schema: 'bellteam.memory.artifact.v1', component: 'memory', sourceCommit: 'e'.repeat(40),
    entry: 'payload/src/run-memory-runtime.mjs', runtime: { os: process.platform, arch: process.arch === 'x64' ? 'amd64' : process.arch,
      nodeMajor: 26, parentProtocol: 1, stateCompatibility: MEMORY_STATE_COMPATIBILITY },
    files: ['run-memory-runtime.mjs', 'memory/dispatcher.mjs', 'memory/state-compatibility.mjs', 'memory-service.mjs', 'memory-search.mjs']
      .map(path => ({ path: `payload/src/${path}`, bytes: 0, sha256: '0'.repeat(64) })),
  }
  assert.equal(validateMemoryReleaseManifest(manifest), manifest)
  const incompatible = structuredClone(manifest); incompatible.runtime.stateCompatibility.searchIndexVersion = 'unknown-ICU'
  assert.throws(() => validateMemoryReleaseManifest(incompatible), { code: 'MEMORY_STATE_INCOMPATIBLE' })
  const missing = structuredClone(manifest); missing.files.shift()
  assert.throws(() => validateMemoryReleaseManifest(missing), { code: 'GATEWAY_RELEASE_INVENTORY_INVALID' })
})

test('the ready probe read is accepted by the real memory service on an empty root', async t => {
  // Contact check against the real validator: a fake child cannot prove the probe arguments are valid.
  const root = await mkdtemp(join(tmpdir(), 'memory-ready-probe-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const memory = new BellTeamMemory({ root, registry: new Map() })
  assert.deepEqual(await memory.recallMemory(MEMORY_READY_PROBE.args[0]), { scope: 'shared', items: [] })
  await assert.rejects(memory.recallMemory({ ...MEMORY_READY_PROBE.args[0], query: '' }), { message: 'SEARCH_QUERY_INVALID' })
})
