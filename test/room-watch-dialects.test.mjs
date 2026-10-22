import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import filesystem from 'node:fs/promises'
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { RoomRegistry } from '../src/room-registry.mjs'

async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'bell-room-watch-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  // root名と部屋IDが同じでも、root通知を一室の変更だと誤認しない。
  const root = join(temporary, 'room-a')
  let index = 0
  const rooms = new RoomRegistry({ roomsRoot: root, bots: new Map(), roomId: () => ['room-a', 'room-b'][index++] })
  await rooms.initialize()
  for (const name of ['A', 'B']) {
    const room = await rooms.create({ name, memberIds: [] })
    await rooms.appendMessage(room.id, { id: 'initial', message: '初期行' })
  }
  const changes = [], watcher = new EventEmitter()
  let callback
  watcher.close = () => {}
  const counts = { stat: 0, readdir: 0, readFile: 0 }, originals = {}
  for (const name of Object.keys(counts)) {
    originals[name] = filesystem[name]
    filesystem[name] = (...args) => { counts[name]++; return originals[name](...args) }
  }
  t.after(() => {
    for (const [name, original] of Object.entries(originals)) filesystem[name] = original
    syncBuiltinESMExports()
  })
  const original = fs.watch
  fs.watch = (_path, _options, listener) => { callback = listener; return watcher }
  syncBuiltinESMExports()
  let stop
  try { stop = await rooms.watch(change => changes.push(change)) }
  finally { fs.watch = original; syncBuiltinESMExports() }
  t.after(stop)
  return { root, rooms, changes, watcher, counts, fire: name => callback('rename', name) }
}

const schedule = value => JSON.stringify({ schema: 'bellteam.schedule.v1', schedules: [], proof: value }) + '\n'
const targeted = (change, topics, id) => {
  assert.equal(change.all, false)
  assert.deepEqual(new Set(change.topics), new Set(topics))
  assert.deepEqual(change.roomIds, [id]); assert.deepEqual(change.botIds, [])
}

test('Macの子/親/root通知が重なっても、予定変更は実差分の部屋だけへ通知する', async t => {
  const f = await fixture(t), path = join(f.root, 'room-a', 'schedule.json')
  for (let i = 0; i < 60; i++) {
    await writeFile(path + '.tmp', schedule(i)); await rename(path + '.tmp', path)
    await Promise.all(['room-a/schedule.json', 'room-a', basename(f.root), null].map(f.fire))
  }
  assert.ok(f.changes.length > 0)
  for (const change of f.changes) targeted(change, ['schedules'], 'room-a')
  const count = f.changes.length
  await f.fire(basename(f.root)); await f.fire(null)
  assert.equal(f.changes.length, count)
  // 同時に届くrootイベントごとに全室を走査し直さず、一群だけを照合する。
  await writeFile(path, schedule('burst'))
  for (const key of Object.keys(f.counts)) f.counts[key] = 0
  await Promise.all(Array.from({ length: 60 }, () => f.fire(basename(f.root))))
  assert.equal(f.counts.readdir, 1); assert.equal(f.counts.stat, 6); assert.equal(f.counts.readFile, 0)
  targeted(f.changes.at(-1), ['schedules'], 'room-a')
  t.diagnostic(JSON.stringify({ rootEvents: 60, rooms: 2, ...f.counts, result: 'schedules/room-a/all:false' }))
})

test('rootだけの通知から複数室の予定・定義・追記を識別し、root名との衝突も扱う', async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'room-b', 'schedule.json'), schedule(1))
  await f.fire(basename(f.root))
  assert.equal(f.changes.length, 1); targeted(f.changes[0], ['schedules'], 'room-b')
  f.changes.length = 0
  await writeFile(join(f.root, 'room-a', 'schedule.json'), schedule(2))
  await writeFile(join(f.root, 'room-b', 'room.json'), JSON.stringify({ schema: 'bellteam.room.v1', name: '変更', memberIds: [] }))
  await appendFile(join(f.root, 'room-b', 'messages.jsonl'), JSON.stringify({ id: 'new', message: '追記' }) + '\n')
  await f.fire(null)
  assert.equal(f.changes.length, 2)
  targeted(f.changes.find(x => x.roomIds.includes('room-a')), ['schedules'], 'room-a')
  targeted(f.changes.find(x => x.roomIds.includes('room-b')), ['rooms', 'timeline'], 'room-b')
})

test('root通知でも履歴置換・縮小・消失は全体照合、部屋の追加削除は取りこぼさない', async t => {
  const f = await fixture(t), path = join(f.root, 'room-a', 'messages.jsonl')
  await writeFile(path, JSON.stringify({ id: 'updated', message: '更新行' }) + '\n')
  await f.fire(null)
  assert.equal(f.changes.at(-1).all, true)
  await writeFile(path + '.new', '{"id":"replacement"}\n'); await rename(path + '.new', path)
  await f.fire(basename(f.root))
  assert.equal(f.changes.at(-1).all, true); assert.ok(f.changes.at(-1).topics.includes('timeline'))
  await writeFile(path, ''); await f.fire('room-a')
  assert.equal(f.changes.at(-1).all, true)
  await rm(path); await f.fire(null)
  assert.equal(f.changes.at(-1).all, true)
  f.changes.length = 0
  await mkdir(join(f.root, 'room-new'))
  await writeFile(join(f.root, 'room-new', 'room.json'), '{}')
  await f.fire(basename(f.root)); targeted(f.changes.at(-1), ['rooms'], 'room-new')
  await rm(join(f.root, 'room-new'), { recursive: true })
  await f.fire(basename(f.root)); targeted(f.changes.at(-1), ['rooms'], 'room-new')
})

test('読取不能とwatch errorは推測で捨てず全体照合する', async t => {
  const f = await fixture(t)
  f.watcher.emit('error', new Error('人工watch失敗'))
  assert.equal(f.changes.at(-1).all, true)
  await rm(f.root, { recursive: true })
  await f.fire(null)
  assert.equal(f.changes.at(-1).all, true)
})
