import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { loadOperation } from '../src/adopter.mjs'

test('Root writable-stage prefix reaches the original /run ancestor check and old RO-stage path is refused', async () => {
  const original = fs.promises.lstat, seen = [], boundary = Error('fixture after prefix validation')
  fs.promises.lstat = async path => { seen.push(path); throw boundary }
  syncBuiltinESMExports()
  const id = '00000000-0000-4000-8000-000000000000', sha = 'a'.repeat(64)
  try {
    await assert.rejects(loadOperation(`/run/bellteam-live-delivery-adoptions/${id}/operation.json`, sha), error => error === boundary)
    assert.deepEqual(seen, ['/run'])
    await assert.rejects(loadOperation(`/run/bellteam-maintenance/runtime-adoptions/${id}/operation.json`, sha), { code: 'LIVE_OPERATION_PATH_INVALID' })
    assert.deepEqual(seen, ['/run'])
  } finally { fs.promises.lstat = original; syncBuiltinESMExports() }
})
