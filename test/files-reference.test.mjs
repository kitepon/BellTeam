import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import test from 'node:test'

import { createConversationAssetsApi } from '../src/http-conversation-api.mjs'
import { createConversationAssetReader } from '../src/conversation-assets.mjs'
import { webMessage } from '../src/http-messages.mjs'
import { validateConversationEffect } from '../src/conversation/effects.mjs'
import { validateConversationRequest } from '../src/conversation/requests.mjs'
import { validateDirectLogRecord } from '../src/direct-log-record.mjs'
import { MessageAssets } from '../src/message-assets.mjs'
import { BellTeamMessenger } from '../src/messenger.mjs'
import { FILE_BYTES_MAX, readOrigin, requireFiles } from '../src/origin-reference.mjs'
import { RoomMessenger } from '../src/room-messenger.mjs'

const at = '2026-11-16T12:20:00.000Z'
const file = (text, name = '報告書.pdf', mime = 'application/pdf') => ({ name, mime, data: Buffer.from(text).toString('base64') })

test('requireFiles: names, types, empty and the 20 MiB x 5 limits with the plain-words message', () => {
  const [one] = requireFiles([{ name: '../a/b\\c\n.txt', mime: 'bad type', data: Buffer.from('hi').toString('base64') }])
  assert.deepEqual([one.name, one.mime], ['.._a_b_c_.txt', 'application/octet-stream'])
  assert.equal(requireFiles([file('x')])[0].mime, 'application/pdf')
  for (const bad of ['x', [{ name: 'a' }], [{ name: 'a', data: '' }], [{ name: 'a', data: '!!' }], [{ name: 'a', data: 'AA==', extra: 1 }]])
    assert.throws(() => requireFiles(bad), { code: 'FILES_INVALID', status: 400 })
  assert.throws(() => requireFiles(Array(6).fill(file('x'))), { code: 'TOO_MANY_FILES', status: 413, message: /20MiB.*5つ/u })
  const big = Buffer.alloc(FILE_BYTES_MAX + 1).toString('base64')
  assert.throws(() => requireFiles([{ name: 'big', data: big }]), { code: 'FILE_TOO_LARGE', status: 413, message: /20MiB/u })
  assert.equal(requireFiles([{ name: 'ok', data: Buffer.alloc(FILE_BYTES_MAX).toString('base64') }]).length, 1)
  // the HTTP edge: limits become a response; a share may bring only files; a plain text post is untouched
  assert.deepEqual(readOrigin({ files: Array(6).fill(file('x')) }, []).status, 413)
  assert.equal(readOrigin({ share: {}, files: [file('x')] }, []).fields.files.length, 1)
  assert.deepEqual(readOrigin({}, []), { fields: {} })
})

test('direct: files are saved as .dat, listed in history without the stored path, and handed to the Bot', async t => {
  const root = await mkdtemp(join(tmpdir(), 'files-direct-')); t.after(() => rm(root, { recursive: true, force: true }))
  const bots = new Map([['bot-a', { id: 'bot-a', name: 'あかり' }]])
  const assets = new MessageAssets({ root }), seen = []
  const logPath = join(root, 'direct.jsonl')
  const messenger = new BellTeamMessenger({ bots, logPath, assets, deliveryId: () => 'id-1', now: () => at,
    transport: { async turn(_bot, text, options) { seen.push([text, options.files]); return 'ok' } } })
  await messenger.userTurn({ target: 'bot-a', message: '', files: [file('PDFの中身'), file('二つ目', 'b.txt', 'text/plain')] })
  const rows = (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  rows.forEach(validateDirectLogRecord)
  const [row] = rows
  assert.deepEqual(row.file_assets.map(({ file: stored, name, mime, size }) => [stored, name, mime, size]),
    [['id-1-d-1.dat', '報告書.pdf', 'application/pdf', 12], ['id-1-d-2.dat', 'b.txt', 'text/plain', 9]])
  assert.equal(row.file_count, 2)
  assert.equal((await readFile(join(root, 'owner/messages/assets/id-1-d-1.dat'), 'utf8')), 'PDFの中身')
  assert.deepEqual(seen[0][1].map(item => item.name), ['報告書.pdf', 'b.txt'])
  const item = webMessage((await messenger.store.timeline('bot-a'))[0])
  assert.deepEqual(item.files, [{ name: '報告書.pdf', mime: 'application/pdf', size: 12, url: '/api/message-files/user/id-1-d-1.dat' },
    { name: 'b.txt', mime: 'text/plain', size: 9, url: '/api/message-files/user/id-1-d-2.dat' }])
  assert.equal(Object.hasOwn(item, 'file_assets'), false)
  // too many / too large never save or deliver
  await assert.rejects(messenger.userTurn({ target: 'bot-a', message: 'x', files: Array(6).fill(file('x')) }), { code: 'TOO_MANY_FILES' })
  assert.equal(seen.length, 1)
})

test('files can be fetched only as a download of opaque bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'files-get-')); t.after(() => rm(root, { recursive: true, force: true }))
  const assets = new MessageAssets({ root })
  await assets.saveFiles({ owner: 'user', id: 'm1', files: [{ name: 'x.html', mime: 'text/html', data: Buffer.from('<script>1</script>').toString('base64') }] })
  const open = createConversationAssetReader({ root })
  const api = createConversationAssetsApi({ assets: { open } })
  const chunks = []
  const response = new Writable({ write(chunk, _enc, done) { chunks.push(chunk); done() } })
  let head
  response.writeHead = (status, headers) => { head = [status, headers] }
  await api({ method: 'GET' }, response, new URL('http://localhost/api/message-files/user/m1-d-1.dat'))
  await new Promise(resolve => response.once('finish', resolve))
  assert.equal(head[0], 200)
  assert.deepEqual([head[1]['content-type'], head[1]['content-disposition'], head[1]['x-content-type-options']],
    ['application/octet-stream', 'attachment; filename="m1-d-1.dat"', 'nosniff'])
  assert.equal(Buffer.concat(chunks).toString(), '<script>1</script>')
  // the image route does not serve .dat
  assert.equal(await api({ method: 'GET' }, response, new URL('http://localhost/api/message-images/user/m1-d-1.dat')), false)
})

test('room: files are saved once and handed to every Bot; a Bot cannot post files; forwarding a message with files is refused', async t => {
  const root = await mkdtemp(join(tmpdir(), 'files-room-')); t.after(() => rm(root, { recursive: true, force: true }))
  const bots = new Map([['bot-a', { id: 'bot-a', name: 'あかり' }]])
  const room = { id: 'room-a', name: '相談', purpose: '共有', memberIds: ['bot-a'] }
  const rooms = new Map([[room.id, room]]), records = [], notified = []
  rooms.appendMessage = async (_id, record) => { records.push(record) }
  rooms.messages = async () => records
  const messenger = new RoomMessenger({ rooms, bots, assets: new MessageAssets({ root }), messageId: () => 'r1', roomTurns: async () => [], chooseResponder: async () => ['bot-a'],
    forwardSource: async () => ({ sender: { id: 'user', name: 'ユーザー' }, at, text: '添付つき', imageAssets: [], fileAssets: [{ owner: 'user', file: 'x-d-1.dat' }] }),
    transport: { async notify(_bot, text, options) { notified.push(options.files); return { delivery: 'running' } } } })
  await messenger.sendroommessage({ from: 'user', room: room.id, message: '見て', files: [file('中身')] })
  const row = records.find(record => record.schema === 'bellteam.room-message.v1')
  assert.deepEqual([row.file_count, row.file_assets[0].file, row.file_assets[0].name], [1, 'r1-d-1.dat', '報告書.pdf'])
  assert.equal(notified[0][0].name, '報告書.pdf')
  await assert.rejects(messenger.sendroommessage({ from: 'bot-a', room: room.id, message: 'x', files: [file('中身')] }), { message: 'ORIGIN_NOT_ALLOWED' })
  await assert.rejects(messenger.sendroommessage({ from: 'user', room: room.id, message: '', forward: { source: { kind: 'bot', id: 'bot-a' }, message_id: 'm' } }), { code: 'FILE_NOT_SUPPORTED', status: 415 })
  assert.equal(records.filter(record => record.schema === 'bellteam.room-message.v1').length, 1)
})

test('the module validators carry files to the execution effect and the request', () => {
  const context = { generation: 'g1', operationId: 'o1', continuation: false, actor: { kind: 'owner' } }
  validateConversationRequest('user.post', { target: 'bot-a', message: '', images: [], files: [file('x')] }, context)
  assert.throws(() => validateConversationRequest('user.post', { target: 'bot-a', message: '', images: [], files: Array(6).fill(file('x')) }, context), { code: 'CONVERSATION_REQUEST_INVALID' })
  assert.throws(() => validateConversationRequest('user.post', { target: 'bot-a', message: '', images: [], files: [{ name: 'a' }] }, context), { code: 'CONVERSATION_REQUEST_INVALID' })
  const effect = { deliveryId: 'd1', target: 'bot-a', message: 'm', queue: { context: 'direct', contextId: 'bot-a', groupId: 'd1', from: 'user', fromName: 'ユーザー', target: 'bot-a', message: 'm' },
    kinds: ['user.complete'], images: [], files: [file('x')] }
  const effectContext = { generation: 'g1', operationId: 'o1', continuation: false, actor: { kind: 'owner' } }
  assert.equal(validateConversationEffect('execution.turn', effect, effectContext), true)
  assert.throws(() => validateConversationEffect('execution.turn', { ...effect, files: [{ name: 'a' }] }, effectContext), { code: 'CONVERSATION_EFFECT_INVALID' })
})
