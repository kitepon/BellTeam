import assert from 'node:assert/strict'
import { fstatSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import test from 'node:test'
import { createConversationAssetsApi } from '../src/http-conversation-api.mjs'
import { MessageAssets } from '../src/message-assets.mjs'

test('画像GETは完了・途中切断・応答エラー・取得待ち中の切断で実ファイルを閉じる', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-http-image-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const assets = new MessageAssets({ root })
  const image = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(256 * 1024)])
  await assets.save({ owner: 'user', id: 'image-1', image: { data: image.toString('base64') } })

  for (const ending of ['finish', 'close', 'error', 'closed-before-open']) {
    await t.test(ending, { timeout: 1000 }, async t => {
      const chunks = []
      const response = new Writable({
        write(chunk, encoding, done) {
          chunks.push(chunk)
          if (ending === 'close') this.destroy()
          done(ending === 'error' ? new Error('client write failed') : undefined)
        },
      })
      response.writeHead = (status, headers) => {
        assert.equal(status, 200)
        assert.equal(headers['content-length'], image.length)
        assert.equal(headers['content-type'], 'image/jpeg')
      }
      // The response error itself is observed even against the old pipe-only handler.
      response.on('error', () => {})
      let stream, fd, closed
      const api = createConversationAssetsApi({ assets: {
        async open(...args) {
          const asset = await assets.open(...args)
          stream = asset.stream
          fd = stream.fd
          closed = new Promise(resolve => stream.once('close', resolve))
          t.after(() => stream.destroy())
          if (ending === 'closed-before-open') response.destroy()
          return asset
        },
      } })
      await api({ method: 'GET' }, response, new URL('http://localhost/api/message-images/user/image-1.jpg'))
      await closed
      assert.equal(stream.closed, true)
      assert.throws(() => fstatSync(fd), { code: 'EBADF' })
      if (ending === 'finish') {
        assert.equal(response.writableFinished, true)
        assert.deepEqual(Buffer.concat(chunks), image)
      }
    })
  }
})
