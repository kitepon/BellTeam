import test from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { qrPng, createSeatLinkQr, ownerMessage } from '../src/approval-box-parent-seat-link-qr.mjs'
import { callSeatLinkTool, seatLinkTools, APPROVAL_BOX_EXTENSION_BOT } from '../src/approval-box-parent-mcp.mjs'

const WAITING = { state: 'waiting', code: 'ABCD-EFGH', typedSecret: 'WXYZ1234QRST5678', qrText: 'PC1PAIR:' + 'x'.repeat(200), expiresAt: '2026-11-27T14:30:00.000Z' }

test('qrPng: a valid grayscale PNG, white quiet zone, black finder corner', () => {
  const png = qrPng('PC1PAIR:hello', { scale: 4, quiet: 4 })
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const size = png.readUInt32BE(16)
  assert.equal(png.readUInt32BE(20), size); assert.equal(png[24], 8); assert.equal(png[25], 0)
  const idat = png.indexOf('IDAT'), length = png.readUInt32BE(idat - 4)
  const raw = inflateSync(png.subarray(idat + 4, idat + 4 + length))
  assert.equal(raw.length, (size + 1) * size)
  const at = (x, y) => raw[y * (size + 1) + 1 + x]
  assert.equal(at(0, 0), 255); assert.equal(at(4 * 4, 4 * 4), 0) // quiet zone white, the top-left finder pattern black
  assert.ok(png.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'))) // IEND
})

test('P8: a waiting view posts one image with the codes to the Owner; the tool answer holds no secret', async () => {
  const posts = []
  const result = await createSeatLinkQr({ pairing: { start: async () => WAITING }, post: async value => { posts.push(value) } }).show()
  assert.deepEqual(result, { outcome: 'posted', expiresAt: WAITING.expiresAt })
  assert.equal(posts.length, 1); assert.equal(posts[0].image.mime, 'image/png')
  assert.match(posts[0].message, /ABCD-EFGH/u); assert.match(posts[0].message, /WXYZ1234QRST5678/u); assert.match(posts[0].message, /23:30まで有効/u)
  const text = JSON.stringify(result)
  assert.ok(!text.includes('ABCD-EFGH') && !text.includes('WXYZ1234QRST5678') && !text.includes('PC1PAIR'))
})

test('P8: linked posts nothing; every refusal is a typed answer; a failed post keeps the pairing for the next call', async () => {
  const none = []
  const post = async value => { none.push(value) }
  assert.deepEqual(await createSeatLinkQr({ pairing: { start: async () => ({ state: 'linked' }) }, post }).show(), { outcome: 'linked' })
  assert.deepEqual(await createSeatLinkQr({ pairing: { start: async () => ({ state: 'failed', reason: 'unavailable' }) }, post }).show(), { outcome: 'not_started', reason: 'unavailable' })
  assert.deepEqual(await createSeatLinkQr({ pairing: { start: async () => { throw new Error('x') } }, post }).show(), { outcome: 'not_started', reason: 'unavailable' })
  assert.deepEqual(await createSeatLinkQr({ pairing: { start: async () => ({ state: 'waiting', code: 'ABCD-EFGH' }) }, post }).show(), { outcome: 'not_started', reason: 'waiting' })
  assert.equal(none.length, 0)
  assert.deepEqual(await createSeatLinkQr({ pairing: { start: async () => WAITING }, post: async () => { throw new Error('down') } }).show(), { outcome: 'post_failed' })
})

test('tool: only the module owner\'s seat, not a fork, through the messenger port as target user', async () => {
  const sent = []
  const messenger = { sendmessage: async value => { sent.push(value); return { delivery: 'delivered' } } }
  const approvalBoxDaemon = { pairing: { start: async () => WAITING } }
  await assert.rejects(callSeatLinkTool({ name: 'approval_box_seat_link_show', from: 'bot-someone-else', approvalBoxDaemon, messenger }), { code: 'APPROVAL_BOX_SEAT_LINK_NOT_ALLOWED' })
  await assert.rejects(callSeatLinkTool({ name: 'approval_box_seat_link_show', from: APPROVAL_BOX_EXTENSION_BOT, fork: true, approvalBoxDaemon, messenger }), { code: 'APPROVAL_BOX_SEAT_LINK_NOT_ALLOWED' })
  await assert.rejects(callSeatLinkTool({ name: 'approval_box_seat_link_show', from: APPROVAL_BOX_EXTENSION_BOT, approvalBoxDaemon: null, messenger }), { code: 'APPROVAL_BOX_DAEMON_UNAVAILABLE' })
  await assert.rejects(callSeatLinkTool({ name: 'approval_box_seat_link_show', args: { extra: 1 }, from: APPROVAL_BOX_EXTENSION_BOT, approvalBoxDaemon, messenger }))
  const result = await callSeatLinkTool({ name: 'approval_box_seat_link_show', from: APPROVAL_BOX_EXTENSION_BOT, approvalBoxDaemon, messenger })
  assert.equal(result.outcome, 'posted')
  assert.equal(sent.length, 1); assert.equal(sent[0].target, 'user'); assert.equal(sent[0].from, APPROVAL_BOX_EXTENSION_BOT); assert.equal(sent[0].images[0].mime, 'image/png')
  assert.equal(seatLinkTools[0].name, 'approval_box_seat_link_show')
})

test('message: names the three iPhone steps and, without an expiry, no time', () => {
  assert.match(ownerMessage(WAITING), /「接続」→「AIをつなぐ」→「QRコードを読む」/u)
  assert.doesNotMatch(ownerMessage({ ...WAITING, expiresAt: null }), /まで有効/u)
})
