import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { AitermTransport } from '../src/aiterm-transport.mjs'

const bot = { id: 'bot-r', session: 'bot-r', project: '/x', harness: 'claude', model: 'm' }
const sha = buf => createHash('sha256').update(buf).digest('hex')
const MiB = 2 ** 20

function transport(handler, session = 'bot-r') {
  const calls = []
  const client = { async call(name, args) { calls.push({ name, args }); return handler(args) } }
  const t = new AitermTransport({ client, resolveBot: () => ({ ...bot, session }), handoffContext: async () => '' })
  t.session = () => session
  return { t, calls }
}
const chunkOf = (data, args) => {
  const part = data.subarray(args.offset, args.offset + args.length)
  return { structuredContent: { chunk_base64: part.toString('base64'), offset: args.offset, total_bytes: data.length, sha256: sha(data), mime_type: 'image/png', path: args.path } }
}
const refusal = code => Object.assign(new Error(code), { aitermErrorCode: code })

test('a 13 MiB image is read in three 6 MiB chunks and checked as a whole', async () => {
  const data = Buffer.alloc(13 * MiB, 7)
  const { t, calls } = transport(async args => chunkOf(data, args))
  const out = await t.readSeatImage(bot, '/Users/x/a.png', 25 * MiB)
  assert.ok(out.equals(data))
  assert.deepEqual(calls.map(c => [c.name, c.args.offset, c.args.length]), [['image_read', 0, 6 * MiB], ['image_read', 6 * MiB, 6 * MiB], ['image_read', 12 * MiB, 6 * MiB]])
  assert.equal(calls[0].args.session_id, 'bot-r')
})

test('over maxBytes is refused on the first chunk; a wrong sha256 or a moved file is unavailable', async () => {
  const data = Buffer.alloc(8 * MiB, 1)
  const big = transport(async args => chunkOf(data, args))
  await assert.rejects(big.t.readSeatImage(bot, '/a.png', 4 * MiB), { code: 'IMAGE_FILE_TOO_LARGE' })
  assert.equal(big.calls.length, 1)
  const bad = transport(async args => { const r = chunkOf(data, args); r.structuredContent.sha256 = 'f'.repeat(64); return r })
  await assert.rejects(bad.t.readSeatImage(bot, '/a.png', 25 * MiB), { code: 'IMAGE_REMOTE_READ_UNAVAILABLE' })
  let n = 0
  const moved = transport(async args => { const r = chunkOf(data, args); if (n++) r.structuredContent.total_bytes += 1; return r })
  await assert.rejects(moved.t.readSeatImage(bot, '/a.png', 25 * MiB), { code: 'IMAGE_REMOTE_READ_UNAVAILABLE' })
})

test('Aiterm codes map to the names conversation returns; anything else, a missing session or an old Aiterm is unavailable; nothing wakes the seat', async () => {
  const map = { IMAGE_NOT_FOUND: 'IMAGE_FILE_NOT_FOUND', IMAGE_TOO_LARGE: 'IMAGE_FILE_TOO_LARGE', IMAGE_NOT_AN_IMAGE: 'IMAGE_FILE_INVALID',
    IMAGE_PATH_INVALID: 'IMAGE_FILE_INVALID', IMAGE_PATH_NOT_ALLOWED: 'IMAGE_PATH_NOT_ALLOWED', SESSION_NOT_FOUND: 'IMAGE_REMOTE_READ_UNAVAILABLE' }
  for (const [from, to] of Object.entries(map)) {
    const { t, calls } = transport(async () => { throw refusal(from) })
    await assert.rejects(t.readSeatImage(bot, '/a.png', MiB), { code: to })
    assert.deepEqual(calls.map(c => c.name), ['image_read'], 'one read, no wake, no launch')
  }
  await assert.rejects(transport(async () => { throw new Error('Tool image_read not found') }).t.readSeatImage(bot, '/a.png', MiB), { code: 'IMAGE_REMOTE_READ_UNAVAILABLE' })
  const none = transport(async () => { throw new Error('unreachable') }, '')
  await assert.rejects(none.t.readSeatImage(bot, '/a.png', MiB), { code: 'IMAGE_REMOTE_READ_UNAVAILABLE' })
  assert.equal(none.calls.length, 0)
})

test('a zero-byte file is one read and an empty Buffer', async () => {
  const { t, calls } = transport(async args => chunkOf(Buffer.alloc(0), args))
  assert.equal((await t.readSeatImage(bot, '/a.png', MiB)).length, 0)
  assert.equal(calls.length, 1)
})
