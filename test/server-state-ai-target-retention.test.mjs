import assert from 'node:assert/strict'
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { transferServerState } from '../src/server-state-transfer.mjs'

const intent = paused => JSON.stringify({ schema: 'bellteam.ai-control.v1', paused, updatedAt: '2026-10-27T06:45:00Z' })
async function fixture(t, direction) {
  const root = await mkdtemp(join(tmpdir(), 'ai-target-retention-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const path of ['bots', 'state/bots', 'shared']) await mkdir(join(root, path), { recursive: true })
  const forward = direction === 'to-server'
  const source = join(root, forward ? 'shared/ai-control.json' : 'state/ai-control.json')
  const target = join(root, forward ? 'state/ai-control.json' : 'shared/ai-control.json')
  const fromMarker = join(root, forward ? 'bots/.initialized' : 'state/bots/.initialized')
  const toMarker = join(root, forward ? 'state/bots/.initialized' : 'bots/.initialized')
  await writeFile(source, intent(true)); await writeFile(fromMarker, '')
  return { root, source, target, fromMarker, toMarker }
}
async function retained(f) {
  assert.equal(await readFile(f.source, 'utf8'), intent(true))
  await lstat(f.fromMarker)
  await assert.rejects(lstat(f.toMarker), { code: 'ENOENT' })
}
test('AI control linked destination is rejected before source retirement or rollback overwrite', async t => {
  for (const [direction, paused] of [['to-server', true], ['to-legacy', true], ['to-legacy', false]]) {
    const f = await fixture(t, direction), held = join(f.root, 'held')
    await writeFile(held, intent(paused)); await link(held, f.target)
    const before = await lstat(f.target)
    const outcome = await transferServerState({ root: f.root, direction }).catch(error => error)
    await retained(f)
    assert.equal(outcome.code, 'SERVER_STATE_FILE_INVALID')
    assert.equal(await readFile(f.target, 'utf8'), intent(paused))
    assert.equal(await readFile(held, 'utf8'), intent(paused))
    const after = await lstat(f.target)
    assert.equal(after.ino, before.ino); assert.equal(after.nlink, 2)
  }
})
test('AI control symbolic destination uses the existing regular-file rejection', async t => {
  for (const direction of ['to-server', 'to-legacy']) {
    const f = await fixture(t, direction), held = join(f.root, 'held')
    await writeFile(held, intent(false)); await symlink(held, f.target)
    await assert.rejects(transferServerState({ root: f.root, direction }), { code: 'SERVER_STATE_FILE_INVALID' })
    await retained(f)
    assert.equal((await lstat(f.target)).isSymbolicLink(), true)
    assert.equal(await readFile(held, 'utf8'), intent(false))
  }
})
test('explicit rollback preserves conflicting regular values rather than overwriting either', async t => {
  const f = await fixture(t, 'to-legacy')
  await writeFile(f.target, intent(false))
  await assert.rejects(transferServerState({ root: f.root, direction: 'to-legacy' }),
    { code: 'SERVER_STATE_TRANSFER_CONFLICT' })
  assert.equal(await readFile(f.target, 'utf8'), intent(false))
  await retained(f)
})
