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

test('files: 0600 temporary copy by the seat UID, path in the text, no image field, removed after the turn (a288)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seat-file-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const requests = [], seat = runtime(root, requests), bytes = Buffer.from('synthetic pdf bytes')
  let sent, path
  const transport = new AitermTransport({
    tempRoot: join(root, 'files'),
    writeTemporaryImage: (file, data) => seat.writeTemporaryImage(file, data),
    removeTemporaryImage: file => seat.removeTemporaryImage(file),
    handoffContext: async () => '', waitProcess: async () => ({ outcome: 'done' }),
    client: { async call(name, args) {
      if (name === 'pty_send') {
        sent = args
        path = /: (\/\S+bellteam-file-\S+)$/mu.exec(args.text)[1]
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
  await transport.notify({ id: 'bot-file', session: 'bot-file', harness: 'codex', project: root }, '資料',
    { files: [{ name: 'レポート\n.PDF', mime: 'application/pdf', data: bytes.toString('base64') }] })
  await transport.idle('bot-file')
  assert.match(sent.text, /^資料\n\n添付ファイル/u)
  assert.match(sent.text, /- レポート .PDF（application\/pdf、19バイト）: /u)
  assert.match(path, /bellteam-file-[0-9a-f-]{36}\.pdf$/u)
  assert.equal(sent.image, undefined)
  assert.deepEqual(requests.map(x => x.action), ['write-image', 'remove-image'])
  await assert.rejects(access(path), { code: 'ENOENT' })
})

test('files: an invalid file removes the images and files already created, nothing is sent (a288)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seat-file-failure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const requests = [], seat = runtime(root, requests)
  const transport = new AitermTransport({ tempRoot: root,
    writeTemporaryImage: (path, bytes) => seat.writeTemporaryImage(path, bytes),
    removeTemporaryImage: path => seat.removeTemporaryImage(path) })
  await assert.rejects(transport.imageFiles([{ mime: 'image/png', data: 'YWJj' }],
    [{ name: 'a.txt', mime: 'text/plain', data: 'YWJj' }, { name: '', data: 'YWJj' }]), /FILE_INVALID/u)
  assert.deepEqual(requests.map(x => x.action), ['write-image', 'write-image', 'remove-image', 'remove-image'])
  for (const request of requests.slice(0, 2)) await assert.rejects(access(request.path), { code: 'ENOENT' })
})

test('files: the execution bridge path sends images in `image` and files as paths in the text (a288)', async () => {
  const { dispatchExecution } = await import('../src/execution-transport.mjs')
  const removed = [], sent = []
  const seat = {
    imageFiles: async (images, files) => [{ path: '/t/bellteam-image-x.png', temporary: true },
      ...files.map(file => ({ path: '/t/bellteam-file-x.pdf', temporary: true, attachment: { name: file.name, mime: file.mime, size: 3 } }))],
    removeTemporaryImages: async list => removed.push(list), session: () => 's1',
  }
  const job = { executionWasPresent: true, execution: { invoke: async (name, args) => {
    sent.push(args)
    return { structuredContent: { mode: 'agent_dispatch', event_cursor: 1, wait_process: {} } }
  } } }
  const delivery = await dispatchExecution(seat, job, { id: 'b' }, 'm', [{}], { check() {}, files: [{ name: 'a.pdf', mime: 'application/pdf' }] })
  assert.deepEqual(sent[0].image, ['/t/bellteam-image-x.png'])
  assert.match(sent[0].text, /^m\n\n添付ファイル.*\n- a\.pdf（application\/pdf、3バイト）: \/t\/bellteam-file-x\.pdf$/su)
  assert.equal(delivery.imageFiles.length, 2)
  assert.equal(removed.length, 0)
})
