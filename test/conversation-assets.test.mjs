import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rename, rm, symlink, truncate } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { finished } from 'node:stream/promises'
import { createConversationAssetReader, createConversationAssetGate } from '../src/conversation-assets.mjs'

const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value }); return { promise, resolve } }

test('parent FD keeps old content through writer/path exchange and closes on EOF or HTTP destroy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-fd-'))
  try {
    const directory = join(root, 'state/bots/bot-a/messages/assets'); await mkdir(directory, { recursive: true })
    const path = join(directory, 'image.png'); await writeFile(path, 'old image')
    const open = createConversationAssetReader({ root })
    const first = await open('bot-a', 'image.png')
    await rename(path, path + '.previous'); await writeFile(path, 'new image')
    const chunks = []; for await (const chunk of first.stream) chunks.push(chunk)
    assert.equal(Buffer.concat(chunks).toString(), 'old image')
    assert.equal(first.stream.closed, true)
    const second = await open('bot-a', 'image.png'); second.stream.destroy(); await finished(second.stream).catch(() => {})
    assert.equal(second.stream.closed, true)
    await assert.rejects(open('../bot', 'image.png'), { code: 'IMAGE_ASSET_INVALID' })
    await symlink(path, join(directory, 'link.png'))
    await assert.rejects(open('bot-a', 'link.png'), { code: 'IMAGE_ASSET_INVALID' })
    await truncate(path, 25 * 1024 * 1024 + 1)
    await assert.rejects(open('bot-a', 'image.png'), { code: 'IMAGE_ASSET_INVALID' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('parent save lease retains read and child completion after caller unknown; deletion waits, other owners continue', async () => {
  const context = {}, read = deferred(), child = deferred()
  const gate = createConversationAssetGate({ readRemovalStates: async () => ({ removals: [] }),
    assertContext: value => { assert.equal(value, context) } })
  await gate.initialize()
  const lease = await gate.beginSave('bot-a', context)
  gate.trackCompletion(lease, read.promise); gate.trackCompletion(lease, child.promise)
  const ending = gate.endSave(lease)
  let removed = false
  const removal = gate.prepareBotAssetRemoval('bot-a', context).then(value => { removed = true; return value })
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(gate.beginSave('bot-a', context), { code: 'IMAGE_BOT_REMOVAL_PENDING' })
  const unrelated = await gate.beginSave('bot-b', context); await gate.endSave(unrelated)
  const user = await gate.beginSave('user', context); await gate.endSave(user)
  read.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(removed, false)
  child.resolve(); await ending; const token = await removal
  assert.equal(gate.cancelBotAssetRemoval('bot-a', 'forged', { active: true, hasIntent: false, retired: false }, context), false)
  assert.equal(gate.cancelBotAssetRemoval('bot-a', token, { active: true, hasIntent: true, retired: false }, context), false)
  assert.equal(gate.cancelBotAssetRemoval('bot-a', token, { active: true, hasIntent: false, retired: false }, context), true)
  const reopened = await gate.beginSave('bot-a', context); await gate.endSave(reopened)
  await assert.rejects(gate.beginSave('bot-a', {}))
})

test('removal restore once stays closed across child replacements; missing/invalid state is fail closed', async () => {
  let reads = 0
  const context = {}, gate = createConversationAssetGate({ readRemovalStates: async () => {
    reads++; return { removals: [{ botId: 'bot-a', active: false, hasIntent: true, retired: true }] }
  }, assertContext: value => assert.equal(value, context) })
  await gate.initialize(); await gate.initialize()
  assert.equal(reads, 1)
  await assert.rejects(gate.beginSave('bot-a', context), { code: 'IMAGE_BOT_REMOVAL_PENDING' })
  const bad = createConversationAssetGate({ readRemovalStates: async () => ({}), assertContext: () => {} })
  await assert.rejects(bad.beginSave('bot-a', context), { code: 'IMAGE_REMOVAL_STATE_INVALID' })
})
