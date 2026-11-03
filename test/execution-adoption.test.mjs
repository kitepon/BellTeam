import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, lstat, readdir, chmod, symlink, link, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutionAdoptionStore } from '../src/execution-adoption.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'execution-adoption-'))
  await mkdir(join(root, 'state'), { mode: 0o700 })
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, path: join(root, 'state/execution-release.json'), store: createExecutionAdoptionStore({ root }) }
}
test('execution selection round trips through the existing private adoption shape and immutable input capture', async t => {
  const f = await fixture(t)
  assert.equal(await f.store.read(), null)
  const value = { currentVersionId: 'a'.repeat(64), previousVersionId: null }
  const saving = f.store.save(value); value.currentVersionId = 'b'.repeat(64)
  await saving
  assert.equal((await f.store.read()).currentVersionId, 'a'.repeat(64))
  assert.equal((await lstat(f.path)).mode & 0o7777, 0o600)
  assert.equal(JSON.parse(await readFile(f.path)).schema, 'bellteam.execution.adoption.v1')
  await f.store.save({ currentVersionId: null, previousVersionId: 'a'.repeat(64) })
  assert.deepEqual(await f.store.read(), { currentVersionId: null, previousVersionId: 'a'.repeat(64) })
  assert.deepEqual(await readdir(join(f.root, 'state')), ['execution-release.json'])
})
test('execution adoption rejects invalid files, symlinks, hardlinks and public write permissions', async t => {
  for (const kind of ['json', 'mode', 'symlink', 'hardlink']) {
    const f = await fixture(t)
    if (kind === 'json') await writeFile(f.path, '{}', { mode: 0o600 })
    else {
      await f.store.save({ currentVersionId: null, previousVersionId: null })
      if (kind === 'mode') await chmod(f.path, 0o660)
      if (kind === 'hardlink') await link(f.path, f.path + '.linked')
      if (kind === 'symlink') { await rm(f.path); await symlink(join(f.root, 'outside'), f.path) }
    }
    await assert.rejects(f.store.read(), /ADOPTION_INVALID/)
    await assert.rejects(f.store.save({ currentVersionId: null, previousVersionId: null }))
  }
})
test('directory sync failure after rename rejects the ACK as unknown while retaining published bytes', async t => {
  const f = await fixture(t), original = fs.promises.open
  fs.promises.open = async (...args) => {
    const file = await original(...args)
    if (args[0] === join(f.root, 'state')) file.sync = async () => { throw new Error('fixture directory sync') }
    return file
  }
  syncBuiltinESMExports()
  try {
    await assert.rejects(f.store.save({ currentVersionId: 'a'.repeat(64), previousVersionId: null }), { outcome: 'unknown' })
  } finally { fs.promises.open = original; syncBuiltinESMExports() }
  assert.equal((await f.store.read()).currentVersionId, 'a'.repeat(64))
})
test('execution store has no arbitrary filename/component input and rejects invalid state roots', async t => {
  const f = await fixture(t)
  await assert.rejects(f.store.save({ currentVersionId: '../outside', previousVersionId: null }), /ADOPTION_INVALID/)
  await assert.rejects(f.store.save({ currentVersionId: null, previousVersionId: null, path: '/outside' }), /ADOPTION_INVALID/)
  assert.throws(() => createExecutionAdoptionStore({ root: '../root' }), /ROOT_INVALID/)
  await chmod(join(f.root, 'state'), 0o770)
  await assert.rejects(f.store.read(), /ADOPTION_INVALID/)
})
