import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationWriter } from '../src/conversation-writer.mjs'

async function fixture(t, prefix = Buffer.alloc(0), onMessage = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'conversation-writer-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const logPath = join(root, 'messages.jsonl')
  await writeFile(logPath, prefix)
  return { logPath, writer: new ConversationWriter({ logPath, onMessage }) }
}

test('crash NUL tail stays byte exact and concurrent appends start separate records', async t => {
  const prefix = Buffer.concat([Buffer.from('{"old":true}\n'), Buffer.alloc(147)])
  const { writer, logPath } = await fixture(t, prefix)
  const records = Array.from({ length: 20 }, (_, id) => ({ id, message: '復旧' }))
  await Promise.all(records.map(record => writer.append(record)))
  const result = await readFile(logPath)
  assert.deepEqual(result.subarray(0, prefix.length), prefix)
  assert.equal(result[prefix.length], 0x0a)
  assert.deepEqual(result.subarray(prefix.length + 1).toString().trimEnd().split('\n').map(JSON.parse), records)
})

test('complete JSON without LF and partial JSON both keep their original bytes', async t => {
  for (const prefix of ['{"old":true}', '{"unfinished":']) {
    const { writer, logPath } = await fixture(t, Buffer.from(prefix))
    await writer.append({ next: true })
    assert.equal(await readFile(logPath, 'utf8'), prefix + '\n{"next":true}\n')
  }
})

test('empty and LF-terminated logs do not gain an extra blank line', async t => {
  for (const prefix of ['', '{"old":true}\n']) {
    const { writer, logPath } = await fixture(t, Buffer.from(prefix))
    await writer.append({ next: true })
    assert.equal(await readFile(logPath, 'utf8'), prefix + '{"next":true}\n')
  }
})

test('notification throw rejects after saving and does not poison subsequent writes', async t => {
  const { writer, logPath } = await fixture(t, Buffer.alloc(0), record => {
    if (record.id === 1) throw new Error('notification failed')
  })
  await assert.rejects(writer.append({ id: 1 }), /notification failed/)
  assert.equal(await readFile(logPath, 'utf8'), '{"id":1}\n')
  await writer.append({ id: 2 })
  assert.equal(await readFile(logPath, 'utf8'), '{"id":1}\n{"id":2}\n')
})

test('failed storage never notifies and the same writer can resume after repair', async t => {
  let notifications = 0
  const { writer, logPath } = await fixture(t, Buffer.alloc(0), () => { notifications++ })
  await rm(logPath)
  await mkdir(logPath)
  await assert.rejects(writer.append({ id: 1 }), { code: 'EISDIR' })
  assert.equal(notifications, 0)
  await rm(logPath, { recursive: true })
  await writer.append({ id: 2 })
  assert.equal(notifications, 1)
  assert.equal(await readFile(logPath, 'utf8'), '{"id":2}\n')
})
