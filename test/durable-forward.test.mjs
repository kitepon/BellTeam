import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { createBotConversationApi } from '../src/http-conversation-api.mjs'
import { DurableMessageReceipts } from '../src/durable-message-receipts.mjs'
import { MessageAssets } from '../src/message-assets.mjs'
import { originFailure } from '../src/origin-reference.mjs'

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 3)])

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'durable-forward-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bots = new Map([['bot-a', { id: 'bot-a', name: 'あかり' }], ['bot-b', { id: 'bot-b', name: 'ゆず' }]])
  const dispatched = []
  let serial = 0
  const assets = new MessageAssets({ root })
  const service = new DurableMessageReceipts({ root, bots, assets, deliveryId: () => `d-${++serial}`, now: () => '2026-11-16T12:20:00.000Z',
    forwardSource: ({ kind, id, messageId }) => kind === 'bot' ? service.store.forwardSource(id, messageId) : null,
    dispatch: async options => { dispatched.push(options); return { delivery: 'running' } } })
  return { root, bots, assets, service, dispatched }
}

test('the direct receive path saves a forward, a share and files, and dispatches them', async t => {
  const f = await fixture(t)
  const rows = async () => (await readFile(f.service.logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  await f.service.receive({ from: 'user', target: 'bot-a', message: 'あかりへの最初の依頼' })      // d-1
  await f.service.receive({ from: 'user', target: 'bot-b', message: 'これも', forward: { source: { kind: 'bot', id: 'bot-a' }, message_id: 'd-1' } })
  await f.service.receive({ from: 'user', target: 'bot-b', message: '', share: { app: 'LINE', text: '共有の文章', urls: ['https://example.com/x'] } })
  await f.service.receive({ from: 'user', target: 'bot-b', message: '資料です', files: [{ name: '報告書.pdf', mime: 'application/pdf', data: Buffer.from('PDFの中身').toString('base64') }] })
  const saved = (await rows()).filter(row => row.schema === 'bellteam.direct-message.v1')
  assert.deepEqual(saved[1].origin, { kind: 'forward', from: { id: 'user', name: 'ユーザー' }, at: '2026-11-16T12:20:00.000Z', content_start: 5 })
  assert.equal(saved[1].message, 'これも\n\nあかりへの最初の依頼')
  assert.deepEqual([saved[2].message, saved[2].origin.kind, saved[2].origin.app], ['共有の文章\nhttps://example.com/x', 'share', 'LINE'])
  assert.deepEqual(saved[3].file_assets.map(({ file, name, size }) => [file, name, size]), [['d-4-d-1.dat', '報告書.pdf', 12]])
  assert.equal(await readFile(join(f.root, 'owner/messages/assets/d-4-d-1.dat'), 'utf8'), 'PDFの中身')
  // the drain hands the saved row, its origin and the file bytes to execution
  await f.service.drain()
  const sent = f.dispatched.find(options => options.record.delivery_id === 'd-4')
  assert.deepEqual(sent.files, [{ name: '報告書.pdf', mime: 'application/pdf', data: Buffer.from('PDFの中身').toString('base64') }])
  assert.equal(f.dispatched.find(options => options.record.delivery_id === 'd-2').record.origin.kind, 'forward')
})

test('a forward of a message with images copies them and dispatches the bytes; unknown or bad input is a 4xx refusal that saves nothing', async t => {
  const f = await fixture(t)
  const original = await f.assets.saveAll({ owner: 'user', id: 'img', images: [{ data: png.toString('base64') }] })
  await f.service.receive({ from: 'user', target: 'bot-a', message: '写真です', images: [{ data: png.toString('base64') }] })   // d-1 (saves d-1-1.png)
  const before = (await readFile(f.service.logPath, 'utf8')).trim().split('\n').length
  assert.equal(original.length, 1)
  await f.service.receive({ from: 'user', target: 'bot-b', message: '', forward: { source: { kind: 'bot', id: 'bot-a' }, message_id: 'd-1' } })   // d-2
  await f.service.drain()
  const sent = f.dispatched.find(options => options.record.delivery_id === 'd-2')
  assert.equal(sent.record.image_assets.length, 1)
  assert.equal(sent.record.image_assets[0].file, 'd-2-f-1.png')
  assert.deepEqual(sent.images, [{ mime: 'image/png', data: png.toString('base64') }])
  const count = async () => (await readFile(f.service.logPath, 'utf8')).trim().split('\n').length
  const after = await count()
  for (const [input, code, status] of [
    [{ forward: { source: { kind: 'bot', id: 'bot-a' }, message_id: 'none' } }, 'FORWARD_SOURCE_NOT_FOUND', 404],
    [{ forward: { source: { kind: 'bot', id: 'bot-a' }, message_id: 'd-1' }, share: { text: 'a' } }, 'ORIGIN_INVALID', 400],
    [{ files: Array(6).fill({ name: 'a', data: 'AA==' }) }, 'TOO_MANY_FILES', 413],
    [{ files: [{ name: 'a' }] }, 'FILES_INVALID', 400],
  ]) await assert.rejects(f.service.receive({ from: 'user', target: 'bot-b', message: 'x', ...input }), error => error.code === code && error.status === status)
  assert.equal(await count(), after)
  // a Bot sender cannot use them
  await assert.rejects(f.service.receive({ from: 'bot-a', target: 'bot-b', message: 'x', share: { text: 'a' } }), { code: 'MESSAGE_INPUT_INVALID' })
  assert.ok(before >= 1)
})

test('the HTTP edge answers an origin refusal with its 4xx instead of 500', async () => {
  assert.deepEqual(originFailure(Object.assign(new Error('FORWARD_SOURCE_NOT_FOUND'), { code: 'FORWARD_SOURCE_NOT_FOUND', status: 404 })), { status: 404, error: 'FORWARD_SOURCE_NOT_FOUND' })
  assert.equal(originFailure(new Error('boom')), null)
  const refusal = Object.assign(new Error('FORWARD_SOURCE_NOT_FOUND'), { code: 'FORWARD_SOURCE_NOT_FOUND', status: 404 })
  const api = createBotConversationApi({ bots: new Map([['bot-a', {}]]), transport: {}, messagePage: async () => ({}), messenger: { enqueueUserTurn: async () => { throw refusal } } })
  const request = Object.assign(Readable.from([Buffer.from(JSON.stringify({ message: 'x', forward: { source: { kind: 'bot', id: 'bot-a' }, message_id: 'm' } }))]), { method: 'POST' })
  const out = []
  const response = { writeHead(status) { out.push(status) }, end(body) { out.push(JSON.parse(body)) }, setHeader() {} }
  await api(request, response, new URL('http://localhost/api/bots/bot-a/messages'))
  assert.deepEqual(out, [404, { error: 'FORWARD_SOURCE_NOT_FOUND' }])
})

// a471-reply-bubble-not-found: the parent's receipts read a machine seat's stream row for reply and forward.
test('a reply to and a forward of a machine seat bubble (me-<seq>-<part>) resolve through machineRow; without it they stay unavailable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'durable-machine-row-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bots = new Map([['bot-a', { id: 'bot-a', name: 'あかり' }]])
  const row = { sender: { id: 'bot-a', name: 'あかり' }, at: '2026-11-21T03:06:00.000Z', text: '調べた結果です。\n二行目' }
  const make = (machineRow, dir) => {
    let serial = 0
    const service = new DurableMessageReceipts({ root: join(root, dir), bots, assets: new MessageAssets({ root: join(root, dir) }), deliveryId: () => `d-${++serial}`,
      now: () => '2026-11-21T03:07:00.000Z', ...(machineRow ? { machineRow } : {}),
      forwardSource: ({ kind, id, messageId }) => kind === 'bot' ? service.store.forwardSource(id, messageId) : null,
      dispatch: async () => ({ delivery: 'running' }) })
    return service
  }
  const rowsOf = async service => (await readFile(service.logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(r => r.schema === 'bellteam.direct-message.v1')
  const calls = []
  const found = make(async (botId, rowId) => { calls.push([botId, rowId]); return rowId === 'me-7970-0' ? row : null }, 'found')
  await found.receive({ from: 'user', target: 'bot-a', message: 'この部分について', replyTo: 'me-7970-0', replyQuote: { text: '調べた結果' } })
  await found.receive({ from: 'user', target: 'bot-a', message: '転送', forward: { source: { kind: 'bot', id: 'bot-a' }, message_id: 'me-7970-0' } })
  const saved = await rowsOf(found)
  assert.deepEqual(calls, [['bot-a', 'me-7970-0'], ['bot-a', 'me-7970-0']])
  assert.equal(saved[0].reply_to.available, true)
  assert.equal(saved[0].reply_to.sender.id, 'bot-a')
  assert.equal(saved[0].reply_to.at, row.at)
  assert.equal(saved[0].reply_to.text, '調べた結果')
  assert.match(saved[1].message, /調べた結果です。/u)
  const missing = make(null, 'missing')
  await missing.receive({ from: 'user', target: 'bot-a', message: 'この部分について', replyTo: 'me-7970-0', replyQuote: { text: '調べた結果' } })
  assert.equal((await rowsOf(missing))[0].reply_to.available, false)
})
