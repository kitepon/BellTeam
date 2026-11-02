import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SeatRuntime } from '../src/seat-runtime.mjs'
import { AitermTransport } from '../src/aiterm-transport.mjs'

function runtime(root, requests) {
  return new SeatRuntime({ root, home: root, run: (command, args, options) => new Promise((resolve, reject) => {
    requests.push(JSON.parse(options.input))
    const child = execFile(command, args, { cwd: root }, (error, stdout) => error ? reject(error) : resolve({ stdout }))
    child.stdin.end(options.input)
  }) })
}

test('添付の作成と完了後の削除を席UIDへ渡し、600の同じbytesをAitermへ届ける', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seat-image-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const requests = [], seat = runtime(root, requests), bytes = Buffer.from('synthetic image bytes')
  let path
  const transport = new AitermTransport({
    tempRoot: join(root, 'images'),
    writeTemporaryImage: (file, data) => seat.writeTemporaryImage(file, data),
    removeTemporaryImage: file => seat.removeTemporaryImage(file),
    handoffContext: async () => '', waitProcess: async () => ({ outcome: 'done' }),
    client: { async call(name, args) {
      if (name === 'pty_send') {
        path = args.image[0]
        assert.deepEqual(await readFile(path), bytes)
        const info = await stat(path)
        assert.equal(info.uid, 1000)
        assert.equal(info.mode & 0o777, 0o600)
        return { structuredContent: { mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: 'synthetic', args: [] } } }
      }
      if (name === 'pty_read') return { content: [{ type: 'text', text: 'synthetic result' }] }
      throw new Error(name)
    } },
  })
  await transport.notify({ id: 'bot-image', session: 'bot-image', harness: 'codex', project: root }, '画像',
    { images: [{ mime: 'image/png', data: bytes.toString('base64') }] })
  await transport.idle('bot-image')
  assert.deepEqual(requests.map(x => x.action), ['write-image', 'remove-image'])
  await assert.rejects(access(path), { code: 'ENOENT' })
})

test('複数添付の途中で失敗した場合も、作成済み画像を席UIDで片付ける', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seat-image-failure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const requests = [], seat = runtime(root, requests)
  const transport = new AitermTransport({ tempRoot: root,
    writeTemporaryImage: (path, bytes) => seat.writeTemporaryImage(path, bytes),
    removeTemporaryImage: path => seat.removeTemporaryImage(path) })
  await assert.rejects(transport.imageFiles([{ mime: 'image/png', data: 'YWJj' }, { mime: 'invalid', data: 'YWJj' }]), /IMAGE_INVALID/u)
  assert.deepEqual(requests.map(x => x.action), ['write-image', 'remove-image'])
  await assert.rejects(access(requests[0].path), { code: 'ENOENT' })
})

test('席の画像操作は生成した名前だけを受け、既存fileやsymlinkを上書きしない', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seat-image-boundary-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const seat = runtime(root, [])
  for (const path of ['relative.png', join(root, 'existing.png'), join(root, 'bellteam-image-bad.png')]) {
    await assert.rejects(seat.writeTemporaryImage(path, Buffer.from('new')), /SEAT_IMAGE_PATH_INVALID/u)
    await assert.rejects(seat.removeTemporaryImage(path), /SEAT_IMAGE_PATH_INVALID/u)
  }
  const target = join(root, 'original'), path = join(root, `bellteam-image-${randomUUID()}.png`)
  await writeFile(target, 'original')
  await symlink(target, path)
  await assert.rejects(seat.writeTemporaryImage(path, Buffer.from('new')), { code: 'EEXIST' })
  assert.equal(await readFile(target, 'utf8'), 'original')
})
