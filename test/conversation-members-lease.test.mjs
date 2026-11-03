import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BellTeamMessenger } from '../src/messenger.mjs'
import { RoomMessenger } from '../src/room-messenger.mjs'

const opaque = () => Object.freeze({ secret: 'private-lease', toJSON() { throw new Error('lease must not serialize') } })

test('直接予定は第2引数の同opaque leaseだけをnotifyへ渡し、保存/queue/本文へ出さない', async t => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-lease-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const logPath = join(root, 'messages.jsonl'), bots = new Map([['bot-a', { id: 'bot-a', name: 'A' }]])
  const refreshed = Promise.withResolvers(), release = Promise.withResolvers(), calls = []
  bots.refresh = async () => { refreshed.resolve(); await release.promise }
  const messenger = new BellTeamMessenger({ bots, logPath,
    transport: { async notify(bot, text, options) { calls.push({ bot, text, options }); return { delivery: 'running' } } } })
  const lease = opaque(), options = { membersLease: lease }
  const result = messenger.sendmessage({ from: 'scheduler', target: 'bot-a', message: 'scheduled', membersLease: opaque() }, options)
  await refreshed.promise
  options.membersLease = opaque()
  release.resolve()
  assert.equal((await result).delivery, 'running')
  assert.equal(calls[0].options.membersLease, lease)
  assert.doesNotMatch(calls[0].text + JSON.stringify(calls[0].options.queue) + await readFile(logPath, 'utf8'), /private-lease|membersLease/u)
  await messenger.sendmessage({ from: 'scheduler', target: 'bot-a', message: 'ordinary', membersLease: opaque() })
  assert.equal(Object.hasOwn(calls[1].options, 'membersLease'), false)
})

for (const firstFails of [false, true]) test(`部屋順序待ちとfanoutで同leaseを保持、先行失敗=${firstFails}`, async () => {
  const bots = new Map(['bot-a', 'bot-b'].map(id => [id, { id, name: id }]))
  const room = { id: 'room-a', name: 'fixture', purpose: '', memberIds: [...bots.keys()], representativeId: null }
  const records = [], calls = [], entered = Promise.withResolvers(), release = Promise.withResolvers()
  const rooms = new Map([[room.id, room]])
  rooms.appendMessage = async (id, record) => { records.push(record) }
  const firstLease = opaque(), secondLease = opaque()
  const messenger = new RoomMessenger({ bots, rooms,
    roomTurns: async ({ text }) => {
      if (text === 'first') { entered.resolve(); await release.promise; if (firstFails) throw new Error('fixture routing failed') }
      return []
    },
    transport: { async notify(bot, text, options) { calls.push({ bot, text, options }); return { delivery: 'running' } } },
  })
  const input = message => ({ from: 'scheduler', room: room.id, message, targets: ['bot-a'], membersLease: opaque() })
  const first = messenger.sendroommessage(input('first'), { membersLease: firstLease })
  const firstResult = firstFails ? assert.rejects(first, /fixture routing failed/u) : first
  await entered.promise
  const options = { membersLease: secondLease }
  const second = messenger.sendroommessage(input('second'), options)
  options.membersLease = opaque()
  assert.equal(calls.length, 0)
  release.resolve()
  await firstResult
  const result = await second
  assert.equal(result.delivery, 'running')
  const secondCalls = calls.filter(call => call.options.queue.message === 'second')
  assert.equal(secondCalls.length, 2)
  assert.ok(secondCalls.every(call => call.options.membersLease === secondLease))
  assert.ok(calls.filter(call => call.options.queue.message === 'first').every(call => call.options.membersLease === firstLease))
  assert.doesNotMatch(JSON.stringify(records) + JSON.stringify(result) + calls.map(call => call.text + JSON.stringify(call.options.queue)).join(''), /private-lease|membersLease/u)
  await messenger.sendroommessage(input('ordinary'))
  assert.ok(calls.filter(call => call.options.queue.message === 'ordinary').every(call => !Object.hasOwn(call.options, 'membersLease')))
})

test('notify拒否は同leaseの一回だけで返し、会話側で再発行しない', async t => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-lease-fail-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const lease = opaque(), failure = new Error('lease rejected'), calls = []
  const messenger = new BellTeamMessenger({ bots: new Map([['bot-a', { id: 'bot-a' }]]), logPath: join(root, 'messages.jsonl'),
    transport: { async notify(bot, text, options) { calls.push(options.membersLease); throw failure } } })
  await assert.rejects(messenger.sendmessage({ from: 'scheduler', target: 'bot-a', message: 'fixture' }, { membersLease: lease }), error => error === failure)
  assert.deepEqual(calls, [lease])
})
