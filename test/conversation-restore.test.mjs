import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RoomRegistry } from '../src/room-registry.mjs'
import { SelfTurns } from '../src/self-turns.mjs'
import { restoreConversationState, readSelfTurnsState } from '../src/conversation/restore.mjs'

async function snapshot(root) {
  const result = {}
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name), info = await stat(path, { bigint: true })
    result[entry.name] = entry.isDirectory() ? await snapshot(path)
      : { data: (await readFile(path)).toString('base64'), mode: info.mode, mtime: info.mtimeNs }
  }
  return result
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'conversation-restore-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bots = new Map([['bot-a', { id: 'bot-a', name: 'A' }]])
  const rooms = new RoomRegistry({ roomsRoot: join(root, 'rooms'), bots, roomId: () => 'room-a' })
  await rooms.initialize()
  await rooms.create({ name: 'fixture', memberIds: ['bot-a'] })
  await rooms.setSchedule('room-a', { kind: 'once', at: '2030-01-01T00:00:00Z', prompt: 'do not issue' })
  await mkdir(join(root, 'logs'))
  const statePath = join(root, 'logs/self-turns.json')
  await writeFile(statePath, JSON.stringify({ schema: 'bellteam.self-turns.v1', bots: {
    'bot-a': { cursor: 'opaque', seen: ['a'], lastCompletedAt: 42 },
  } }))
  return { root, bots, rooms, statePath }
}

test('read-only restore changes no bytes/mode/mtime and invokes no external work', async t => {
  const f = await fixture(t), before = await snapshot(f.root)
  const state = await restoreConversationState(f)
  assert.equal(state.rooms.get('room-a').name, 'fixture')
  assert.equal(state.selfState['bot-a'].cursor, 'opaque')
  assert.deepEqual(await state.store.records(), [])
  assert.deepEqual(await snapshot(f.root), before)
  const forbidden = () => assert.fail('restore must not issue work')
  const self = new SelfTurns({ bots: f.bots, statePath: f.statePath, read: forbidden, changed: forbidden, appendAnswer: forbidden, afterTurn: forbidden })
  await self.restore()
  assert.deepEqual(self.state, state.selfState)
  assert.deepEqual(await snapshot(f.root), before)
})

test('missing schedule is refused without creating it, while legacy list may create during bootstrap', async t => {
  const f = await fixture(t), path = join(f.root, 'rooms/room-a/schedule.json')
  await rm(path)
  const before = await snapshot(f.root)
  await assert.rejects(restoreConversationState(f), { code: 'ENOENT' })
  assert.deepEqual(await snapshot(f.root), before)
  assert.deepEqual(await f.rooms.listSchedules('room-a'), [])
  assert.equal(JSON.parse(await readFile(path, 'utf8')).schema, 'bellteam.schedule.v1')
})

test('malformed Room or schedule state is rejected without repair', async t => {
  for (const [name, value] of [['room.json', '{}'], ['schedule.json', '{'],
    ['schedule.json', JSON.stringify({ schema: 'unknown', schedules: [] })],
    ['schedule.json', JSON.stringify({ schema: 'bellteam.schedule.v1', schedules: [null] })]]) {
    const f = await fixture(t)
    await writeFile(join(f.root, 'rooms/room-a', name), value)
    const before = await snapshot(f.root)
    await assert.rejects(restoreConversationState(f))
    assert.deepEqual(await snapshot(f.root), before)
  }
})

test('self state absence is initial empty; corrupt/unknown state never becomes empty ready', async t => {
  const f = await fixture(t)
  await rm(f.statePath)
  assert.deepEqual(await readSelfTurnsState(f.statePath), {})
  await assert.rejects(stat(f.statePath), { code: 'ENOENT' })
  for (const value of ['{', '{}', JSON.stringify({ schema: 'unknown', bots: {} }),
    JSON.stringify({ schema: 'bellteam.self-turns.v1', bots: { 'bot-a': { seen: 42 } } })]) {
    await writeFile(f.statePath, value)
    await assert.rejects(readSelfTurnsState(f.statePath))
    assert.equal(await readFile(f.statePath, 'utf8'), value)
  }
})

test('a verified Bot Map is required and absent rooms directory is not created by restore', async t => {
  const f = await fixture(t)
  await assert.rejects(restoreConversationState({ root: f.root, bots: null }), { code: 'CONVERSATION_BOTS_SNAPSHOT_REQUIRED' })
  await rm(join(f.root, 'rooms'), { recursive: true })
  await assert.rejects(restoreConversationState(f), { code: 'ENOENT' })
  await assert.rejects(stat(join(f.root, 'rooms')), { code: 'ENOENT' })
})
