import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { restoreConversationState } from '../src/conversation/restore.mjs'
import { SelfTurns } from '../src/self-turns.mjs'

async function snapshot(root) {
  const result = {}
  for (const name of await readdir(root)) {
    const path = join(root, name), info = await stat(path, { bigint: true })
    result[name] = { mode: info.mode, mtime: info.mtimeNs, value: info.isDirectory()
      ? await snapshot(path) : (await readFile(path)).toString('base64') }
  }
  return result
}

test('the fixed distribution probe state restores read-only with no observer/Jev/notification work', async t => {
  const fixture = JSON.parse(await readFile(new URL('../src/conversation/probe-fixture.json', import.meta.url), 'utf8'))
  assert.deepEqual(Object.keys(fixture), ['bots', 'files'])
  const root = await mkdtemp(join(tmpdir(), 'conversation-fixed-probe-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [relative, value] of Object.entries(fixture.files)) {
    const path = join(root, relative)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  }
  const before = await snapshot(root), bots = new Map(fixture.bots.map(bot => [bot.id, bot]))
  const state = await restoreConversationState({ root, bots })
  assert.deepEqual([...state.rooms.values()], [Object.fromEntries(Object.entries(fixture.files['rooms/room-conversation-probe/room.json'])
    .filter(([key]) => key !== 'schema'))])
  assert.deepEqual(state.selfState, fixture.files['logs/self-turns.json'].bots)
  assert.deepEqual(await state.store.records(), [])
  assert.deepEqual(await state.rooms.messages('room-conversation-probe'), [])
  const effects = []
  const forbidden = (...args) => { effects.push(args); assert.fail('probe restore must not issue work') }
  const self = new SelfTurns({ bots, statePath: join(root, 'logs/self-turns.json'),
    read: forbidden, changed: forbidden, appendAnswer: forbidden, afterTurn: forbidden })
  await self.restore()
  assert.deepEqual(self.state, state.selfState)
  assert.deepEqual(effects, [])
  assert.deepEqual(await snapshot(root), before)
})
