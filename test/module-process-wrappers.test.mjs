import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDiagnosticsProcess } from '../src/diagnostics-process.mjs'
import { createUsageProcess } from '../src/usage-process.mjs'
import { createUsageAuthority } from '../src/usage/authority.mjs'
import { createUsageProjection } from '../src/usage/projection.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'

async function fixture(t, component) {
  const root = await mkdtemp(join(tmpdir(), 'module-wrapper-')), children = []
  await mkdir(join(root, 'state'))
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  })
  return { root, children, probeCandidate: async () => {}, spawnProcess: (entry, args, options) => {
    assert.equal(entry, `/usr/local/libexec/bellteam-${component}-start`)
    assert.equal(options.serialization, 'advanced')
    for (const child of children) assert.ok(child.exitCode !== null || child.signalCode !== null)
    const child = spawn(process.execPath, [new URL('./fixtures/module-wrapper-child.mjs', import.meta.url).pathname, component, root, args[0]], options)
    children.push(child); return child
  }, prepareRelease: async versionId => ({ versionId, appRoot: `/run/bellteam-maintenance/${component}/releases/${versionId}/payload` }) }
}

test('diagnostics fixed wrapper connects actual record/list and closes its IPC child', { timeout: 10000 }, async t => {
  const f = await fixture(t, 'diagnostics'), controller = createDiagnosticsProcess(f)
  try {
    await controller.start()
    const row = await controller.request('record', { report: { code: 'SERVER_HTTP_503', module: 'server' } })
    const rows = await controller.request('list', {})
    assert.equal(rows[0].fingerprint, row.fingerprint)
    assert.equal(rows[0].occurrence_count, 1)
  } finally { await controller.close() }
  assert.equal(f.children[0].connected, false)
  assert.equal(f.children[0].stdout.closed, true)
})

test('usage wrapper stages bootstrap, activates real resume and restores a fixed version with private handoff', { timeout: 20000 }, async t => {
  const f = await fixture(t, 'usage'), admission = new MembersAdmission('usage'), authority = createUsageAuthority()
  const bots = new Map([['bot-a', { id: 'bot-a', name: 'A', harness: 'codex' }]]), projection = createUsageProjection({ bots })
  const controller = createUsageProcess({ ...f, admission, authorizeActor: authority.authorizeActor,
    bootstrap: { environment: {}, seatRuntime: false, subscription: {} },
    onEffect: async method => method === 'members.read' ? [...bots.values()] : method === 'rooms.read' ? [] : null,
    onProjection: (row, context) => context.phase === 'seed' ? projection.seed(row, context.generation) : projection.accept(row, context.generation),
    onSnapshotStart: context => projection.begin(context.generation),
    onSnapshotEnd: context => projection.commit(context.generation),
    onSnapshotAbort: context => projection.discard(context.generation),
  })
  try {
    const start = await controller.start()
    assert.equal(start.phase, 'initializing'); assert.equal(start.available, false)
    assert.equal(projection.configuration('routing').enabled, false)
    await assert.rejects(controller.request('settings.list', {}), /NOT_ACCEPTING/)
    await controller.initialize('subscriptions'); await controller.initialize('services')
    await controller.activate()
    assert.equal(controller.snapshot().available, true)
    const read = () => admission.withLease(async lease => {
      const token = authority.capture('settings.list', { kind: 'owner', botId: null })
      try { return await controller.request('settings.list', {}, { usageLease: lease, capturedAuthorization: token }) }
      finally { authority.release(token) }
    })
    assert.equal((await read()).length, 6)
    await controller.replace('a'.repeat(64))
    assert.equal((await read()).length, 6)
    assert.equal(controller.snapshot().currentVersionId, 'a'.repeat(64))
  } finally { await controller.close() }
  assert.equal(f.children.length, 2)
})

test('automatic recovery restores usage services without a handoff', { timeout: 20000 }, async t => {
  const f = await fixture(t, 'usage'), admission = new MembersAdmission('usage'), authority = createUsageAuthority()
  const bots = new Map([['bot-a', { id: 'bot-a', name: 'A', harness: 'codex' }]]), projection = createUsageProjection({ bots })
  const controller = createUsageProcess({ ...f, admission, authorizeActor: authority.authorizeActor,
    bootstrap: { environment: {}, seatRuntime: false, subscription: {} },
    onEffect: async method => method === 'members.read' ? [...bots.values()] : method === 'rooms.read' ? [] : null,
    onProjection: (row, context) => context.phase === 'seed' ? projection.seed(row, context.generation) : projection.accept(row, context.generation),
    onSnapshotStart: context => projection.begin(context.generation),
    onSnapshotEnd: context => projection.commit(context.generation),
    onSnapshotAbort: context => projection.discard(context.generation),
  })
  try {
    const start = await controller.start()
    assert.equal(start.phase, 'initializing'); assert.equal(start.available, false)
    assert.equal(projection.configuration('routing').enabled, false)
    await assert.rejects(controller.request('settings.list', {}), /NOT_ACCEPTING/)
    await controller.initialize('subscriptions'); await controller.initialize('services')
    await controller.activate()
    assert.equal(controller.snapshot().available, true)
    const read = () => admission.withLease(async lease => {
      const token = authority.capture('settings.list', { kind: 'owner', botId: null })
      try { return await controller.request('settings.list', {}, { usageLease: lease, capturedAuthorization: token }) }
      finally { authority.release(token) }
    })
    assert.equal((await read()).length, 6)
    f.children[0].kill('SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 1400))
    assert.equal(controller.snapshot().available, true)
    assert.equal((await read()).length, 6)
    assert.equal(controller.snapshot().currentVersionId, null)
  } finally { await controller.close() }
  assert.equal(f.children.length, 2)
})


test('automatic recovery preserves diagnostics records in the same root', async t => {
  const f = await fixture(t, 'diagnostics'), controller = createDiagnosticsProcess(f)
  try {
    await controller.start()
    await controller.request('record', { report: { code: 'SERVER_HTTP_503', module: 'server' } })
    f.children[0].kill('SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 1400))
    assert.equal(f.children.length, 2)
    assert.equal((await controller.request('list', {})).length, 1)
  } finally { await controller.close() }
})
