import assert from 'node:assert/strict'
import fs from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import test from 'node:test'
import {migrateServerState, relocateServerRoots} from '../src/server-state-transfer.mjs'

test('nested root rejection precedes all backup and relocation filesystem operations', async t => {
  const original = fs.promises.lstat
  let reads = 0
  fs.promises.lstat = async () => {
    reads++
    throw Object.assign(new Error('unexpected filesystem read'), {code:'COUNTER_FILESYSTEM_READ'})
  }
  syncBuiltinESMExports()
  t.after(() => { fs.promises.lstat = original; syncBuiltinESMExports() })
  for (const [legacyRoot, serverRoot] of [
    ['/synthetic/root', '/synthetic/root/state'],
    ['/synthetic/root/state', '/synthetic/root'],
    ['/synthetic/root', '/synthetic/root/nested/..'],
    ['/', '/synthetic/root'],
  ]) for (const direction of ['to-server', 'to-legacy']) {
    const options = {legacyRoot, serverRoot, backupRoot:'/synthetic/backup', direction}
    for (const run of [relocateServerRoots, migrateServerState]) {
      await assert.rejects(run(options), {code:'SERVER_STATE_RELOCATION_ALIAS'})
    }
  }
  assert.equal(reads, 0)
})

test('separate same-prefix roots retain normal transfer and latest-data return', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'state-root-boundary-'))
  t.after(() => rm(parent, {recursive:true, force:true}))
  const legacyRoot = join(parent, 'old'), serverRoot = join(parent, 'old-copy')
  await mkdir(join(legacyRoot, 'state'), {recursive:true})
  await mkdir(serverRoot)
  await writeFile(join(legacyRoot, 'state/value'), 'original')
  assert.equal((await relocateServerRoots({legacyRoot, serverRoot, direction:'to-server'})).status, 'relocated')
  assert.equal(await readFile(join(serverRoot, 'state/value'), 'utf8'), 'original')
  await writeFile(join(serverRoot, 'state/value'), 'latest')
  assert.equal((await relocateServerRoots({legacyRoot, serverRoot, direction:'to-legacy'})).status, 'relocated')
  assert.equal(await readFile(join(legacyRoot, 'state/value'), 'utf8'), 'latest')
})
