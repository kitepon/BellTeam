import test from 'node:test'
import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { readServerSourceCommit } from '../src/server-source.mjs'

const sourceCommit = 'a'.repeat(40)
const info = { isFile: () => true, uid: 0, nlink: 1, mode: 0o644, size: 200 }
test('gateway builtin identity reads only immutable same-image metadata and closes it', async () => {
  let closed = 0
  assert.equal(await readServerSourceCommit(async (path, flags) => {
    assert.equal(path, '/app/distribution.json')
    assert.ok(flags & constants.O_NOFOLLOW); assert.ok(flags & constants.O_NONBLOCK)
    assert.equal(flags & 3, constants.O_RDONLY)
    return { stat: async () => info, readFile: async () => JSON.stringify({ schema: 'bellteam.server.distribution.v1', sourceCommit }), close: async () => { closed++ } }
  }), sourceCommit)
  assert.equal(closed, 1)
})
test('missing, writable or untrusted image metadata leaves builtin source unknown', async () => {
  assert.equal(await readServerSourceCommit(async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }), null)
  for (const changed of [{ uid: 1000 }, { nlink: 2 }, { mode: 0o664 }, { size: 4097 }, { isFile: () => false }]) {
    let closed = false
    assert.equal(await readServerSourceCommit(async () => ({ stat: async () => ({ ...info, ...changed }), readFile: async () => { assert.fail('untrusted metadata was read') }, close: async () => { closed = true } })), null)
    assert.equal(closed, true)
  }
  for (const value of ['invalid-json', JSON.stringify({ schema: 'other', sourceCommit }), JSON.stringify({ schema: 'bellteam.server.distribution.v1', sourceCommit: 'a'.repeat(64) })])
    assert.equal(await readServerSourceCommit(async () => ({ stat: async () => info, readFile: async () => value, close: async () => {} })), null)
})
