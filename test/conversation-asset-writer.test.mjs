import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MessageAssets } from '../src/message-assets.mjs'

const png = Buffer.from('89504e470d0a1a0a', 'hex')
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'conversation-asset-writer-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, assets: new MessageAssets({ root, ...options }) }
}

test('child writer acquires parent admission before read and retains one lease through every batch write', async t => {
  const calls = [], entered = Promise.withResolvers(), release = Promise.withResolvers()
  const { root, assets } = await fixture(t, { saveAdmission: {
    async beginSave(owner) { calls.push(['begin', owner]); return 'wire-lease' },
    async endSave(lease) {
      assert.deepEqual(await readFile(join(root, 'bots/bot-a/messages/assets/batch-2.png')), png)
      calls.push(['end', lease])
    },
  }, readImage: async image => { calls.push(['read', image]); if (image === 1) { entered.resolve(); await release.promise } return png } })
  const saving = assets.saveAll({ owner: 'bot-a', id: 'batch', images: [1, 2] })
  await entered.promise
  assert.deepEqual(calls, [['begin', 'bot-a'], ['read', 1]])
  release.resolve()
  const saved = await saving
  assert.deepEqual(calls, [['begin', 'bot-a'], ['read', 1], ['read', 2], ['end', 'wire-lease']])
  assert.doesNotMatch(JSON.stringify(saved), /wire-lease/u)
})

test('parent refusal starts no image read/write, and failed write still requests parent terminal', async t => {
  const refusal = new Error('parent gate closed'), calls = []
  const first = await fixture(t, { saveAdmission: { async beginSave() { throw refusal }, async endSave() { assert.fail('no lease') } }, readImage: () => assert.fail('no read') })
  await assert.rejects(first.assets.save({ owner: 'bot-a', id: 'one', image: {} }), error => error === refusal)
  const readFailure = new Error('read failed')
  const second = await fixture(t, { saveAdmission: { async beginSave() { return 'lease' }, async endSave(lease) { calls.push(lease) } }, readImage: async () => { throw readFailure } })
  await assert.rejects(second.assets.save({ owner: 'bot-a', id: 'one', image: {} }), error => error === readFailure)
  assert.deepEqual(calls, ['lease'])
})

test('write and terminal request failures both survive instead of hiding the primary failure', async t => {
  const primary = new Error('write failed'), terminal = new Error('parent ACK unknown')
  const { assets } = await fixture(t, { saveAdmission: { async beginSave() { return 'lease' }, async endSave() { throw terminal } }, readImage: async () => { throw primary } })
  await assert.rejects(assets.save({ owner: 'user', id: 'one', image: {} }), error => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors, [primary, terminal])
    return true
  })
})

test('child writer never restores or operates the parent deletion gate or opens a read FD', async t => {
  const saveAdmission = { async beginSave() { return 'lease' }, async endSave() {} }
  const { assets } = await fixture(t, { saveAdmission })
  await assert.rejects(assets.open('user', 'one.png'), /IMAGE_ASSET_READ_PARENT_ONLY/u)
  await assert.rejects(assets.prepareBotAssetRemoval('bot-a'), /IMAGE_ASSET_GATE_PARENT_ONLY/u)
  assert.throws(() => assets.cancelBotAssetRemoval('bot-a', 'lease', {}), /IMAGE_ASSET_GATE_PARENT_ONLY/u)
  assert.throws(() => new MessageAssets({ root: '/unused', saveAdmission, readRemovalStates: () => assert.fail('restore') }), /IMAGE_ASSET_ADMISSION_INVALID/u)
})
