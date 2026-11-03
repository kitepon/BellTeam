import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createModuleProcess } from '../src/module-process.mjs'
import { createDiagnosticsParentChannel } from '../src/diagnostics-ipc.mjs'
import { validateDiagnosticsReady } from '../src/diagnostics-protocol.mjs'

test('actual diagnostics channel keeps same saved records/notes through controller builtin-release-builtin', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'diagnostics-controller-')), children = []
  await mkdir(join(root, 'state'))
  const notes = join(root, 'notes.json'), fingerprint = createHash('sha256').update('SERVER_HTTP_503:server').digest('hex')
  const investigation = { summary: '設置別根拠', evidence: ['fixture/one'], updated_at: '2026-11-03T00:00:00Z' }
  await writeFile(notes, JSON.stringify({ [fingerprint]: investigation }))
  const noteStat = await stat(notes), sha = 'a'.repeat(64)
  const controller = createModuleProcess({ component: 'diagnostics', root, investigationsFile: notes,
    createChannel: createDiagnosticsParentChannel, validateReady: validateDiagnosticsReady,
    prepareRelease: async versionId => ({ versionId, appRoot: `/run/bellteam-maintenance/diagnostics/releases/${versionId}/payload` }),
    spawnProcess: (entry, args, options) => {
      assert.equal(entry, '/usr/local/libexec/bellteam-diagnostics-start')
      assert.deepEqual(options.env, { BELLTEAM_DIAGNOSTIC_INVESTIGATIONS: notes })
      assert.equal(options.serialization, 'advanced')
      for (const old of children) {
        assert.notEqual(old.exitCode, null)
        assert.equal(old.connected, false)
        assert.equal(old.stdout.closed, true)
        assert.equal(old.stderr.closed, true)
      }
      // This fixture exercises real IPC/OS boundaries with the same code; signature/C/UID are separate native checks.
      const child = spawn(process.execPath, [new URL('./fixtures/diagnostics-runtime-child.mjs', import.meta.url).pathname, root, args[0]], options)
      children.push(child)
      return child
    },
  })
  t.after(async () => { await controller.close(); await rm(root, { recursive: true, force: true }) })
  await controller.start()
  const generations = [controller.snapshot().generation]
  const row = await controller.request('record', { report: { code: 'SERVER_HTTP_503', module: 'server', diagnostic_log: 'original' } })
  assert.equal(row.fingerprint, fingerprint)
  await controller.request('setStatus', { fingerprint, status: 'resolved', note: '後日判定' })
  await controller.replace(sha)
  generations.push(controller.snapshot().generation)
  assert.equal(controller.snapshot().currentVersionId, sha)
  const [restored] = await controller.request('list', {})
  assert.equal(restored.diagnostic_log, 'original')
  assert.equal(restored.status, 'resolved')
  assert.equal(restored.occurrence_count, 1)
  assert.equal(restored.diagnostic_context.investigation_note.summary, '後日判定')
  assert.deepEqual(restored.investigation, investigation)
  await controller.request('record', { report: { code: 'SERVER_HTTP_503', module: 'server' } })
  await controller.replace('builtin')
  generations.push(controller.snapshot().generation)
  const [returned] = await controller.request('list', {})
  assert.equal(returned.occurrence_count, 2)
  assert.equal(returned.status, 'open')
  assert.equal(returned.diagnostic_log, 'original')
  assert.equal(returned.investigation_note.occurrence_count, 1)
  assert.deepEqual(returned.investigation, investigation)
  assert.equal((await stat(notes)).mtimeMs, noteStat.mtimeMs)
  const adoption = JSON.parse(await readFile(join(root, 'state/diagnostics-release.json'), 'utf8'))
  assert.equal(adoption.currentVersionId, null)
  assert.equal(adoption.previousVersionId, sha)
  assert.equal(new Set(generations).size, 3)
  assert.equal(new Set(children.map(child => child.pid)).size, 3)
  await controller.close()
  for (const child of children) assert.equal(child.exitCode, 0)
})
