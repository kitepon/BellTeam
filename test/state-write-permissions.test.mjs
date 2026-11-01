import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Diagnostics } from '../src/diagnostics.mjs'
import { RoomRegistry } from '../src/room-registry.mjs'

test('diagnostic saves stay private and initialize repairs an existing public file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-diagnostic-mode-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const previous = process.umask(0o022)
  t.after(() => process.umask(previous))
  const file = join(root, 'diagnostics.json')
  const diagnostics = new Diagnostics(file)
  await diagnostics.initialize()
  await diagnostics.record({ code: 'SERVER_HTTP_500', module: 'server' })
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  await chmod(file, 0o644)
  const reloaded = new Diagnostics(file)
  await reloaded.initialize()
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  await reloaded.record({ code: 'SERVER_HTTP_500', module: 'server' })
  assert.equal(reloaded.list()[0].occurrence_count, 2)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
})

test('new rooms stay private and initialize repairs existing room directories', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-room-mode-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const previous = process.umask(0o022)
  t.after(() => process.umask(previous))
  const options = { roomsRoot: root, bots: new Map(), roomId: () => 'room-test' }
  const rooms = new RoomRegistry(options)
  await rooms.initialize()
  await rooms.create({ name: 'Private room', memberIds: [] })
  const directory = join(root, 'room-test')
  assert.equal((await stat(directory)).mode & 0o777, 0o700)
  await chmod(directory, 0o755)
  const reloaded = new RoomRegistry(options)
  await reloaded.initialize()
  assert.equal((await stat(directory)).mode & 0o777, 0o700)
  assert.equal(reloaded.get('room-test').name, 'Private room')
})
