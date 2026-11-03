import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CONVERSATION_STATE_COMPATIBILITY as compatibility, assertConversationStateCompatibility } from '../src/conversation/state-compatibility.mjs'
import { ConversationStore } from '../src/conversation-store.mjs'
import { RoomHistory } from '../src/room-history.mjs'
import { MessageAssets } from '../src/message-assets.mjs'
import { SelfTurns } from '../src/self-turns.mjs'

const fixture = JSON.parse(await readFile(new URL('./fixtures/conversation-reader-v1.json', import.meta.url), 'utf8'))
const line = value => JSON.stringify(value) + '\n'
async function file(t) {
  const root = await mkdtemp(join(tmpdir(), 'conversation-reader-contract-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, path: join(root, 'messages.jsonl') }
}

test('state compatibility is exact seven keys, ordered arrays, and immutable exports', () => {
  assert.equal(Object.keys(compatibility).length, 7)
  assertConversationStateCompatibility(structuredClone(compatibility))
  for (const value of [null, {}, { ...compatibility, extra: true }, { ...compatibility, readerContract: 'unknown' },
    { ...compatibility, imageMimeTypes: [...compatibility.imageMimeTypes].reverse() },
    { ...compatibility, directRecordSchemas: compatibility.directRecordSchemas.slice(1) }])
    assert.throws(() => assertConversationStateCompatibility(value), { code: 'CONVERSATION_STATE_INCOMPATIBLE' })
  const missing = structuredClone(compatibility); delete missing.roomSchema
  assert.throws(() => assertConversationStateCompatibility(missing), { code: 'CONVERSATION_STATE_INCOMPATIBLE' })
  assert.throws(() => compatibility.imageMimeTypes.push('image/unknown'), TypeError)
})

test('direct reader preserves optional fields and accepted/unknown status without changing the disk', async t => {
  const { path } = await file(t), content = line(fixture.direct) + line(fixture.interim) + line(fixture.status)
  await writeFile(path, content)
  const store = new ConversationStore({ logPath: path })
  const [record] = await store.records()
  assert.deepEqual(record.optional_future, { keep: true })
  assert.equal(record.delivery, 'failed')
  const timeline = await store.timeline('bot-a')
  assert.deepEqual(timeline.find(item => item.id === 'delivery-a').deliveryTracking,
    { schema: 'bellteam.delivery-tracking.v1', admission: 'accepted', completion: 'unknown' })
  assert.equal(timeline.find(item => item.id === 'word-a').message, '途中')
  assert.equal(await readFile(path, 'utf8'), content)
})

test('both readers preview complete JSON without newline exactly once when the newline arrives', async t => {
  for (const room of [false, true]) {
    const { path } = await file(t), record = room ? fixture.room : fixture.direct
    await writeFile(path, JSON.stringify(record))
    const reader = room ? new RoomHistory(path) : new ConversationStore({ logPath: path })
    const read = () => room ? reader.messages() : reader.records()
    assert.equal((await read()).length, 1)
    await appendFile(path, '\n')
    assert.equal((await read()).length, 1)
  }
})

test('incomplete tail is held by direct and rejected by Room without repair', async t => {
  for (const room of [false, true]) {
    const { path } = await file(t), content = line(room ? fixture.room : fixture.direct) + '{"schema":'
    await writeFile(path, content)
    if (room) await assert.rejects(new RoomHistory(path).messages(), SyntaxError)
    else assert.equal((await new ConversationStore({ logPath: path }).records()).length, 1)
    assert.equal(await readFile(path, 'utf8'), content)
  }
})

test('direct rejects an unknown schema while Room retains the existing unknown object behavior', async t => {
  const { path } = await file(t)
  await writeFile(path, line(fixture.unknownRoom))
  await assert.rejects(new ConversationStore({ logPath: path }).entries(), /MESSAGE_LOG_INVALID/u)
  assert.deepEqual(await new RoomHistory(path).messages(), [{ ...fixture.unknownRoom, routing: undefined }])
})

test('invalid complete batches do not partially replace a previously read snapshot', async t => {
  for (const room of [false, true]) {
    const { path } = await file(t), initial = room ? fixture.room : fixture.direct
    await writeFile(path, line(initial))
    const reader = room ? new RoomHistory(path) : new ConversationStore({ logPath: path })
    const read = () => room ? reader.messages() : reader.records()
    assert.equal((await read()).length, 1)
    await appendFile(path, line({ ...initial, id: 'second', delivery_id: 'second' }) + 'null\n')
    await assert.rejects(read())
    assert.equal(reader.read.offset, Buffer.byteLength(line(initial)))
    await assert.rejects(read())
  }
})

test('Room routing and target status remain separate, including accepted completion unknown', async t => {
  const { path } = await file(t), content = line(fixture.room) + line(fixture.routing) + line(fixture.roomStatus)
  await writeFile(path, content)
  const [message] = await new RoomHistory(path).messages()
  assert.deepEqual(message.routing, fixture.routing.routing)
  assert.equal(message.deliveries[0].delivery, 'failed')
  assert.deepEqual(message.deliveries[0].deliveryTracking, fixture.roomStatus.delivery_tracking)
  assert.deepEqual(message.optional_future, { keep: true })
  assert.equal(await readFile(path, 'utf8'), content)
})

test('missing histories remain empty and an existing self-turn cursor is read without observer calls', async t => {
  const { root, path } = await file(t)
  assert.deepEqual(await new ConversationStore({ logPath: path }).records(), [])
  assert.deepEqual(await new RoomHistory(path).messages(), [])
  const statePath = join(root, 'self-turns.json'), content = line(fixture.selfTurns)
  await writeFile(statePath, content)
  const forbidden = () => assert.fail('reader fixture must not issue external work')
  const turns = new SelfTurns({ bots: new Map(), statePath, appendAnswer: forbidden, read: forbidden, changed: forbidden })
  await turns.initialize()
  assert.deepEqual(turns.state, fixture.selfTurns.bots)
  assert.equal(await readFile(statePath, 'utf8'), content)
})

test('all declared image signatures keep wx/0600 read behavior and symlink refusal', async t => {
  const { root } = await file(t), assets = new MessageAssets({ root })
  for (const [mime, hex] of Object.entries(fixture.imageSignatures)) {
    const bytes = Buffer.from(hex, 'hex'), saved = await assets.save({ owner: 'user', id: mime.split('/')[1], image: { data: bytes.toString('base64') } })
    assert.equal(saved.mime, mime)
    assert.equal((await stat(join(assets.directory('user'), saved.file))).mode & 0o777, 0o600)
    const opened = await assets.open('user', saved.file), chunks = []
    for await (const chunk of opened.stream) chunks.push(chunk)
    assert.deepEqual(Buffer.concat(chunks), bytes)
    await assert.rejects(assets.save({ owner: 'user', id: mime.split('/')[1], image: { data: bytes.toString('base64') } }), /IMAGE_ASSET_DUPLICATE/u)
  }
  await symlink(join(root, 'owner/messages/assets/png.png'), join(root, 'owner/messages/assets/link.png'))
  await assert.rejects(assets.open('user', 'link.png'), /IMAGE_ASSET_INVALID/u)
})
