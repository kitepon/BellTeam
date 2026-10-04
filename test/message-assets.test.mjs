import assert from 'node:assert/strict'
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MessageAssets } from '../src/message-assets.mjs'

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])

test('Botが提示する画像をBot永続領域へ保存して読み出す', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-assets-'))
  const source = join(root, 'generated-image')
  await writeFile(source, png)
  const assets = new MessageAssets({ root })

  const saved = await assets.save({ owner: 'bot-a', id: 'delivery-1', image: { path: source } })

  assert.deepEqual(saved, { owner: 'bot-a', file: 'delivery-1.png', mime: 'image/png' })
  assert.deepEqual(await readFile(join(root, 'bots/bot-a/messages/assets/delivery-1.png')), png)
  const opened = await assets.open(saved.owner, saved.file)
  const chunks = []
  for await (const chunk of opened.stream) chunks.push(chunk)
  assert.deepEqual(Buffer.concat(chunks), png)
})

test('画像でないファイルと永続領域内のsymlinkを拒否する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-assets-invalid-'))
  const source = join(root, 'text.txt')
  await writeFile(source, 'not an image')
  const assets = new MessageAssets({ root })
  await assert.rejects(assets.save({ owner: 'bot-a', id: 'delivery-1', image: { path: source } }), /IMAGE_FILE_INVALID/u)

  const directory = join(root, 'bots/bot-a/messages/assets')
  await assets.save({ owner: 'bot-a', id: 'delivery-2', image: { data: png.toString('base64') } })
  await symlink(source, join(directory, 'delivery-3.png'))
  await assert.rejects(assets.open('bot-a', 'delivery-3.png'), /IMAGE_ASSET_INVALID/u)
})

test('オーナーの画像はBotのプロジェクトではなくオーナーの場所へ順番の番号を付けて置く', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-assets-owner-'))
  const assets = new MessageAssets({ root })
  const saved = await assets.saveAll({ owner: 'user', id: 'delivery-1', images: [{ mime: 'image/png', data: 'iVBORw0KGgo=' }, { mime: 'image/jpeg', data: '/9j/4A==' }] })
  assert.deepEqual(saved.map(asset => asset.file), ['delivery-1-1.png', 'delivery-1-2.jpg'])
  const opened = await assets.open('user', 'delivery-1-1.png')
  opened.stream.destroy()
  assert.equal(opened.mime, 'image/png')
  assert.equal(assets.directory('user'), join(root, 'owner', 'messages', 'assets'))
})
