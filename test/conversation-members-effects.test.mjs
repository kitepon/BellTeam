import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MessageAssets } from '../src/message-assets.mjs'
import { RoomRegistry } from '../src/room-registry.mjs'
import { createConversationServices } from '../src/conversation-services.mjs'

const png = Buffer.from('89504e470d0a1a0a00', 'hex')
const image = { data: png.toString('base64') }
const at = '2026-11-03T00:00:00.000Z'
const ranAt = '2026-11-03T01:00:00.000Z'
const fresh = { active: true, hasIntent: false, retired: false }
const deferred = () => Promise.withResolvers()

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'conversation-members-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function roomFixture(t, input = {}) {
  const root = await directory(t)
  const rooms = new RoomRegistry({ roomsRoot: join(root, 'rooms'),
    bots: new Map(['bot-a', 'bot-b'].map(id => [id, { id }])),
    roomId: () => 'room-a', id: () => 'schedule-a', now: () => new Date('2026-11-02T00:00:00Z') })
  await rooms.initialize()
  await rooms.create({ name: 'fixture', memberIds: ['bot-a', 'bot-b'] })
  const schedule = await rooms.setSchedule('room-a', { kind: 'once', at, prompt: 'fixture', targets: ['bot-b'], ...input })
  return { root, rooms, schedule, request: { roomId: 'room-a', scheduleId: schedule.id,
    expectedRevision: schedule.revision, expectedNextRunAt: schedule.nextRunAt, ranAt } }
}

test('Room同tuple競合は一度消化し、revision不変のtargets整理後のsnapshotを返す', async t => {
  const { rooms, schedule, request } = await roomFixture(t)
  await rooms.removeBot('bot-b')
  assert.equal((await rooms.listSchedules('room-a'))[0].revision, schedule.revision)
  const claims = await Promise.all([rooms.claimDue(request), rooms.claimDue(request), rooms.skipDue(request)])
  const accepted = claims.filter(Boolean)
  assert.equal(accepted.length, 1)
  assert.deepEqual(accepted[0].targets, [])
  assert.equal(accepted[0].enabled, true)
  assert.equal(accepted[0].lastRunAt, null)
  const [saved] = await rooms.listSchedules('room-a')
  assert.equal(saved.enabled, false)
  assert.equal(saved.nextRunAt, null)
  assert.equal(saved.lastRunAt, ranAt)
})

test('Room claimは変更済み/未来/無効/消去/異なるnextRunAtを発行権へ変えない', async t => {
  for (const variant of ['edited', 'future', 'disabled', 'removed', 'next']) await t.test(variant, async t => {
    const { rooms, schedule, request } = await roomFixture(t)
    if (variant === 'edited') await rooms.setSchedule('room-a', { ...schedule, prompt: 'new' })
    if (variant === 'future') request.ranAt = '2026-11-02T23:59:59.000Z'
    if (variant === 'disabled') await rooms.setSchedule('room-a', { ...schedule, enabled: false })
    if (variant === 'removed') await rooms.removeSchedule('room-a', schedule.id)
    if (variant === 'next') request.expectedNextRunAt = '2026-11-02T00:00:00.000Z'
    const before = await rooms.listSchedules('room-a')
    assert.equal(await rooms.claimDue(request), null)
    assert.deepEqual(await rooms.listSchedules('room-a'), before)
  })
})

test('Room skipはlegacy revision0のlastRunAtを保持して反復を進める', async t => {
  const { rooms, schedule, request } = await roomFixture(t, { kind: 'cron', expression: '0 * * * *', timezone: 'UTC' })
  delete schedule.revision
  schedule.lastRunAt = '2026-11-01T00:00:00.000Z'
  await rooms.writeScheduleDocument('room-a', [schedule])
  request.expectedRevision = 0
  const before = await rooms.skipDue(request)
  assert.deepEqual(before, schedule)
  const [saved] = await rooms.listSchedules('room-a')
  assert.equal(saved.lastRunAt, schedule.lastRunAt)
  assert.ok(Date.parse(saved.nextRunAt) > Date.parse(ranAt))
  assert.equal(await rooms.claimDue(request), null)
})

test('Room評価時刻/revision不正を拒否し、保存後応答不明は再claimしない', async t => {
  const { rooms, request } = await roomFixture(t)
  for (const patch of [{ ranAt: null }, { ranAt: 'invalid' }, { expectedNextRunAt: null }, { expectedRevision: -1 }]) {
    await assert.rejects(rooms.claimDue({ ...request, ...patch }), /SCHEDULE_(AT|REVISION)_INVALID/u)
  }
  const write = rooms.writeScheduleDocument.bind(rooms)
  rooms.writeScheduleDocument = async (...args) => { await write(...args); throw new Error('response unknown') }
  await assert.rejects(rooms.claimDue(request), /response unknown/u)
  rooms.writeScheduleDocument = write
  assert.equal(await rooms.claimDue(request), null)
})

test('Room削除は進行claim保存と直列化し、消した部屋を再作成しない', async t => {
  const { root, rooms, request } = await roomFixture(t)
  const entered = deferred(), release = deferred()
  const write = rooms.writeScheduleDocument.bind(rooms)
  rooms.writeScheduleDocument = async (...args) => { entered.resolve(); await release.promise; return write(...args) }
  const claim = rooms.claimDue(request)
  await entered.promise
  const removing = rooms.remove('room-a')
  release.resolve()
  assert.ok(await claim)
  await removing
  assert.equal(await rooms.claimDue(request), null)
  await assert.rejects(access(join(root, 'rooms/room-a')), /ENOENT/u)
})

test('Room保存拒否では消化前snapshotを返さず、修復後だけclaimできる', async t => {
  const { rooms, request } = await roomFixture(t)
  const write = rooms.writeScheduleDocument.bind(rooms)
  rooms.writeScheduleDocument = async () => { throw new Error('write denied') }
  await assert.rejects(rooms.claimDue(request), /write denied/u)
  assert.equal((await rooms.listSchedules('room-a'))[0].enabled, true)
  rooms.writeScheduleDocument = write
  assert.ok(await rooms.claimDue(request))
})

test('対象画像はreadImageから全batch writeまでdrain、他Bot/userは継続する', async t => {
  const root = await directory(t), entered = deferred(), release = deferred()
  const assets = new MessageAssets({ root, readImage: async value => {
    if (value.block) { entered.resolve(); await release.promise }
    return png
  } })
  const saving = assets.saveAll({ owner: 'bot-a', id: 'batch', images: [{ block: true }, image] })
  await entered.promise
  let drained = false
  const preparing = assets.prepareBotAssetRemoval('bot-a').then(lease => { drained = true; return lease })
  const same = assets.prepareBotAssetRemoval('bot-a')
  await assert.rejects(assets.save({ owner: 'bot-a', id: 'late', image }), /IMAGE_BOT_REMOVAL_PENDING/u)
  await assets.save({ owner: 'bot-b', id: 'other', image })
  await assets.save({ owner: 'user', id: 'owner', image })
  assert.equal(drained, false)
  release.resolve()
  assert.equal((await saving).length, 2)
  const lease = await preparing
  assert.equal(await same, lease)
  assert.deepEqual(await readFile(join(root, 'bots/bot-a/messages/assets/batch-2.png')), png)
  await mkdir(join(root, 'retired'))
  await rename(join(root, 'bots/bot-a'), join(root, 'retired/bot-a'))
  await assert.rejects(assets.save({ owner: 'bot-a', id: 'after', image }), /IMAGE_BOT_REMOVAL_PENDING/u)
  await assert.rejects(access(join(root, 'bots/bot-a')), /ENOENT/u)
})

test('read失敗もwrite失敗もsettle後drainし、gateを勝手に開けない', async t => {
  const root = await directory(t), entered = deferred(), release = deferred()
  const assets = new MessageAssets({ root, readImage: async () => {
    entered.resolve(); await release.promise; throw new Error('fixture read failed')
  } })
  const save = assets.save({ owner: 'bot-a', id: 'one', image })
  const failed = assert.rejects(save, /fixture read failed/u)
  await entered.promise
  const prepare = assets.prepareBotAssetRemoval('bot-a')
  release.resolve()
  await failed
  assert.equal(typeof await prepare, 'string')
  const brokenRoot = join(root, 'blocked')
  await writeFile(brokenRoot, '')
  const broken = new MessageAssets({ root: brokenRoot })
  const failedWrite = assert.rejects(broken.save({ owner: 'bot-a', id: 'one', image }), /ENOTDIR/u)
  await broken.prepareBotAssetRemoval('bot-a')
  await failedWrite
  await assert.rejects(broken.save({ owner: 'bot-a', id: 'two', image }), /IMAGE_BOT_REMOVAL_PENDING/u)
})

test('cancelはfresh厳密条件と同Bot同gate leaseだけ、旧cancelで新削除を開けない', async t => {
  const assets = new MessageAssets({ root: await directory(t) })
  const first = await assets.prepareBotAssetRemoval('bot-a')
  for (const state of [null, {}, { ...fresh, active: false }, { ...fresh, hasIntent: true }, { ...fresh, retired: true }]) {
    assert.equal(assets.cancelBotAssetRemoval('bot-a', first, state), false)
  }
  const other = await assets.prepareBotAssetRemoval('bot-b')
  assert.equal(assets.cancelBotAssetRemoval('bot-a', other, fresh), false)
  assert.equal(assets.cancelBotAssetRemoval('bot-a', first, fresh), true)
  await assets.save({ owner: 'bot-a', id: 'reopened', image })
  const second = await assets.prepareBotAssetRemoval('bot-a')
  assert.notEqual(second, first)
  assert.equal(assets.cancelBotAssetRemoval('bot-a', first, fresh), false)
  await assert.rejects(assets.save({ owner: 'bot-a', id: 'new-delete', image }), /IMAGE_BOT_REMOVAL_PENDING/u)
  await assert.rejects(assets.prepareBotAssetRemoval('user'), /IMAGE_ASSET_INVALID/u)
})

test('factoryは初回fresh receipt/退役復元までBot保存を待ち、userと同parent gateを保つ', async t => {
  const root = await directory(t), restore = deferred()
  let reads = 0
  const bots = { readRemovalStates: () => { reads++; return restore.promise } }
  const conversation = createConversationServices({ root, bots, transport: {}, notifications: {}, aiControl: {}, settings: {} })
  const { assets } = conversation
  let completed = false
  const saving = assets.save({ owner: 'bot-a', id: 'one', image }).finally(() => { completed = true })
  const rejected = assert.rejects(saving, /IMAGE_BOT_REMOVAL_PENDING/u)
  await assets.save({ owner: 'user', id: 'owner', image })
  assert.equal(completed, false)
  restore.resolve({ removals: [{ botId: 'bot-a', active: true, hasIntent: true, retired: false },
    { botId: 'bot-retired', active: false, hasIntent: true, retired: true }] })
  await assets.initialize()
  await rejected
  await assert.rejects(assets.save({ owner: 'bot-retired', id: 'one', image }), /IMAGE_BOT_REMOVAL_PENDING/u)
  await assets.save({ owner: 'bot-b', id: 'one', image })
  bots.readRemovalStates = async () => ({ removals: [] })
  await assets.initialize()
  assert.equal(reads, 1)
  assert.equal(conversation.assets, assets)
  await assert.rejects(assets.save({ owner: 'bot-a', id: 'two', image }), /IMAGE_BOT_REMOVAL_PENDING/u)
})

test('restore不明/破損はBot保存をfail closed、user保存と履歴readに波及しない', async t => {
  for (const state of [null, {}, { removals: [{ botId: 'bot-a', active: true, hasIntent: true, retired: true }] },
    { removals: [{ botId: 'bot-a', active: true, hasIntent: false, retired: false }] }]) {
    const assets = new MessageAssets({ root: await directory(t), readRemovalStates: async () => state })
    await assert.rejects(assets.initialize())
    await assert.rejects(assets.save({ owner: 'bot-a', id: 'one', image }))
    const saved = await assets.save({ owner: 'user', id: 'owner', image })
    const opened = await assets.open(saved.owner, saved.file)
    opened.stream.destroy()
  }
  const assets = new MessageAssets({ root: await directory(t), readRemovalStates: async () => { throw new Error('offline') } })
  await assert.rejects(assets.initialize(), /offline/u)
  await assert.rejects(assets.save({ owner: 'bot-a', id: 'one', image }), /offline/u)
})

test('factory明示providerのrestore失敗はinitialize先頭で止まり、監視を開始しない', async t => {
  let reads = 0
  const conversation = createConversationServices({ root: await directory(t), bots: {}, transport: {},
    notifications: {}, aiControl: {}, settings: {}, readRemovalStates: async () => { reads++; throw new Error('restore unavailable') } })
  await assert.rejects(conversation.initialize(), /restore unavailable/u)
  assert.equal(reads, 1)
  await conversation.assets.save({ owner: 'user', id: 'owner', image })
})
