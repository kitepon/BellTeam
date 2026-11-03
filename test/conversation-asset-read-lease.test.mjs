import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MessageAssets } from '../src/message-assets.mjs'

test('parallel child saves bind each runtime image read to its own admitted wire lease', async t => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-asset-read-lease-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bothRead = Promise.withResolvers(), release = Promise.withResolvers(), calls = []
  const assets = new MessageAssets({ root, saveAdmission: {
    async beginSave(owner) { return `wire-${owner}` }, async endSave(lease) { calls.push(['end', lease]) },
  }, readImage: async (image, maxBytes, lease) => {
    assert.equal(maxBytes, 25 * 1024 * 1024)
    assert.equal(lease, `wire-${image.owner}`)
    calls.push(['read', lease])
    if (calls.length === 2) bothRead.resolve()
    await release.promise
    return Buffer.from('89504e470d0a1a0a', 'hex')
  } })
  const first = assets.save({ owner: 'bot-a', id: 'first', image: { owner: 'bot-a' } })
  const second = assets.saveAll({ owner: 'user', id: 'batch', images: [{ owner: 'user' }, { owner: 'user' }] })
  await bothRead.promise
  assert.equal(calls.filter(([kind]) => kind === 'end').length, 0)
  release.resolve()
  const saved = await Promise.all([first, second])
  assert.equal(calls.filter(([kind, lease]) => kind === 'read' && lease === 'wire-user').length, 2)
  assert.deepEqual(calls.filter(([kind]) => kind === 'end').map(([, lease]) => lease).sort(), ['wire-bot-a', 'wire-user'])
  assert.doesNotMatch(JSON.stringify(saved), /wire-/u)
})
