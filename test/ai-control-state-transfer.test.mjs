import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { transferAiControlState } from '../src/ai-control-state-transfer.mjs'

const state = (paused, updatedAt, resumedAt = null) => JSON.stringify({
  schema: 'bellteam.ai-control.v1', paused, updatedAt, resumedAt,
}) + '\n'

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'bellteam-control-transfer-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const legacyRoot = join(base, 'legacy'), stateRoot = join(base, 'private/state')
  await mkdir(join(legacyRoot, 'shared'), { recursive: true })
  return { legacyRoot, stateRoot, legacy: join(legacyRoot, 'shared/ai-control.json'), server: join(stateRoot, 'ai-control.json') }
}

test('offline transfer preserves paused intent byte-for-byte and keeps the source', async t => {
  const paths = await fixture(t)
  const original = state(true, '2026-10-21T21:00:00Z', '2026-10-21T20:00:00Z')
  await writeFile(paths.legacy, original)
  assert.deepEqual(await transferAiControlState({ ...paths, direction: 'to-server' }), { direction: 'to-server', status: 'copied' })
  assert.equal(await readFile(paths.server, 'utf8'), original)
  assert.equal(await readFile(paths.legacy, 'utf8'), original)
  assert.equal((await stat(paths.server)).mode & 0o777, 0o600)
  assert.equal((await stat(paths.stateRoot)).mode & 0o777, 0o700)
  assert.equal((await transferAiControlState({ ...paths, direction: 'to-server' })).status, 'unchanged')
})

test('older valid control files without resumedAt are preserved without inventing a timestamp', async t => {
  const paths = await fixture(t)
  const original = '{"schema":"bellteam.ai-control.v1","paused":true,"updatedAt":"2026-10-21T19:00:00Z"}\n'
  await writeFile(paths.legacy, original)
  await transferAiControlState({ ...paths, direction: 'to-server' })
  assert.equal(await readFile(paths.server, 'utf8'), original)
})

test('rollback carries the current resumedAt and later pause instead of restoring a backup', async t => {
  const paths = await fixture(t)
  await writeFile(paths.legacy, state(true, '2026-10-21T19:00:00Z'))
  await transferAiControlState({ ...paths, direction: 'to-server' })
  const resumed = state(false, '2026-10-21T21:01:00Z', '2026-10-21T21:01:00Z')
  await writeFile(paths.server, resumed)
  await transferAiControlState({ ...paths, direction: 'to-legacy' })
  assert.equal(await readFile(paths.legacy, 'utf8'), resumed)
  const pausedAgain = state(true, '2026-10-21T21:02:00Z', '2026-10-21T21:01:00Z')
  await writeFile(paths.server, pausedAgain)
  await transferAiControlState({ ...paths, direction: 'to-legacy' })
  assert.equal(await readFile(paths.legacy, 'utf8'), pausedAgain)
  assert.equal(await readFile(paths.server, 'utf8'), pausedAgain)
})

test('missing or malformed source leaves destination untouched; migration conflict preserves newer intent', async t => {
  const paths = await fixture(t)
  await mkdir(paths.stateRoot, { recursive: true })
  const current = state(true, '2026-10-21T21:02:00Z')
  await writeFile(paths.server, current)
  await assert.rejects(transferAiControlState({ ...paths, direction: 'to-server' }), { code: 'ENOENT' })
  for (const invalid of ['{}', '{', state(true, 'bad'), state(false, '2026-10-21T21:00:00Z', 'bad')]) {
    await writeFile(paths.legacy, invalid)
    await assert.rejects(transferAiControlState({ ...paths, direction: 'to-server' }), { code: 'AI_CONTROL_TRANSFER_INVALID' })
    assert.equal(await readFile(paths.server, 'utf8'), current)
  }
  await writeFile(paths.legacy, state(false, '2026-10-21T20:00:00Z'))
  await assert.rejects(transferAiControlState({ ...paths, direction: 'to-server' }), { code: 'AI_CONTROL_TRANSFER_CONFLICT' })
  assert.equal(await readFile(paths.server, 'utf8'), current)
  assert.deepEqual(await readdir(paths.stateRoot), ['ai-control.json'])
})

test('source and destination symlinks are not followed', async t => {
  const paths = await fixture(t)
  await writeFile(join(paths.legacyRoot, 'original'), state(true, '2026-10-21T21:00:00Z'))
  await symlink('../original', paths.legacy)
  await assert.rejects(transferAiControlState({ ...paths, direction: 'to-server' }), { code: 'ELOOP' })
  await rm(paths.legacy)
  await writeFile(paths.legacy, state(false, '2026-10-21T21:01:00Z', '2026-10-21T21:01:00Z'))
  await mkdir(paths.stateRoot, { recursive: true })
  await symlink(paths.legacy, paths.server)
  await assert.rejects(transferAiControlState({ ...paths, direction: 'to-server' }), { code: 'AI_CONTROL_TRANSFER_NOT_FILE' })
})
