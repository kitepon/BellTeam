import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSeatEntryPublisher, ENTRIES_SCHEMA } from '../src/approval-box-entries.mjs'

const e1 = version => ({ schema: ENTRIES_SCHEMA, product: 'approval-box', version, mcpServers: { 'approval-box': { claude: { type: 'stdio', command: '/usr/local/bin/node', args: [`/home/bell/.approval-box/runtime/${version}/cli.mjs`, 'mcp'] } } } })
async function setup(t, answer) {
  const root = await mkdtemp(join(tmpdir(), 'abe-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'state', 'approval-box-extension', 'harness-entries.json')
  const calls = []
  const state = { answer }
  const run = (cmd, args, options) => { calls.push([cmd, args, options.signal instanceof AbortSignal, options.maxBuffer]); return new Promise((resolve, reject) => typeof state.answer === 'function' ? state.answer(resolve, reject) : state.answer instanceof Error ? reject(state.answer) : resolve({ stdout: state.answer })) }
  return { file, calls, state, publisher: createSeatEntryPublisher({ file, seatHome: '/home/bell', run }) }
}

test('publish writes the seats runtime entry as an atomic, readable file and runs the seat profile binary read-only', async t => {
  const { publisher, file, calls } = await setup(t, JSON.stringify(e1('0.2.0-pc.5')))
  assert.deepEqual(await publisher.publish(), { ok: true, changed: true, version: '0.2.0-pc.5' })
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), e1('0.2.0-pc.5'))
  assert.equal((await stat(file)).mode & 0o777, 0o644)
  assert.equal((await stat(join(file, '..'))).mode & 0o755, 0o755)
  assert.deepEqual(calls[0], ['/home/bell/.approval-box/bin/approval-box', ['harness-entries', '--json'], true, 1048576])
  assert.deepEqual(await readdir(join(file, '..')), ['harness-entries.json'])
})

test('an unchanged answer writes nothing; a new runtime replaces the file', async t => {
  const { publisher, file, state } = await setup(t, JSON.stringify(e1('0.2.0-pc.5')))
  await publisher.publish()
  const before = (await stat(file)).mtimeMs
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal((await publisher.publish()).changed, false)
  assert.equal((await stat(file)).mtimeMs, before)
  state.answer = JSON.stringify(e1('0.2.0-pc.6'))
  assert.deepEqual(await publisher.publish(), { ok: true, changed: true, version: '0.2.0-pc.6' })
  assert.equal(JSON.parse(await readFile(file, 'utf8')).version, '0.2.0-pc.6')
})

test('an unreadable, wrong-schema or failing answer keeps the last file', async t => {
  const { publisher, file, state } = await setup(t, JSON.stringify(e1('0.2.0-pc.5')))
  await publisher.publish()
  for (const bad of [new Error('exec'), 'not json', JSON.stringify({ ...e1('x'), schema: 'other' }), JSON.stringify({ ...e1('x'), product: 'caveat' }), JSON.stringify({ ...e1('x'), mcpServers: null })]) {
    state.answer = bad
    assert.deepEqual(await publisher.publish(), { ok: false, changed: false, reason: 'unreadable' })
  }
  assert.equal(JSON.parse(await readFile(file, 'utf8')).version, '0.2.0-pc.5')
})

test('no file is created when the runtime was never readable, and a second publish while one runs is busy', async t => {
  const { publisher, file, state } = await setup(t, new Error('no runtime'))
  assert.equal((await publisher.publish()).reason, 'unreadable')
  assert.equal(await readFile(file, 'utf8').catch(() => 'absent'), 'absent')
  let release
  state.answer = resolve => { release = () => resolve({ stdout: JSON.stringify(e1('0.2.0-pc.5')) }) }
  const first = publisher.publish()
  assert.equal((await publisher.publish()).reason, 'busy')
  release(); assert.equal((await first).ok, true)
})

test('a missing runner is refused at construction', () => {
  assert.throws(() => createSeatEntryPublisher({ file: '/x/y.json' }), /SEAT_ENTRY_RUNNER_REQUIRED/)
})

test('start publishes at once and close stops the timer', async t => {
  const timers = []
  const root = await mkdtemp(join(tmpdir(), 'abe-')); t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'e', 'harness-entries.json')
  const publisher = createSeatEntryPublisher({ file, run: async () => ({ stdout: JSON.stringify(e1('0.2.0-pc.5')) }), setTimer: (fn, ms) => { timers.push([fn, ms]); return { unref() {} } }, clearTimer: () => timers.push('cleared') })
  publisher.start()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(JSON.parse(await readFile(file, 'utf8')).version, '0.2.0-pc.5')
  assert.equal(timers[0][1], 60000)
  publisher.close(); assert.equal(timers.at(-1), 'cleared')
})

test('the folder is 0755 and the file 0644 even under a 077 umask', async t => {
  const before = process.umask(0o077)
  t.after(() => process.umask(before))
  const { publisher, file } = await setup(t, JSON.stringify(e1('0.2.0-pc.5')))
  await publisher.publish()
  assert.equal((await stat(join(file, '..'))).mode & 0o777, 0o755)
  assert.equal((await stat(file)).mode & 0o777, 0o644)
})

test('the body starts and closes the publisher (the connector that used to carry it was removed 2026-11-28 and the entries file went stale)', async () => {
  const { readFile } = await import('node:fs/promises')
  const services = await readFile(new URL('../src/application-services.mjs', import.meta.url), 'utf8'), runtime = await readFile(new URL('../src/application-runtime.mjs', import.meta.url), 'utf8')
  assert.match(services, /createSeatEntryPublisher\(\{ file: join\(root, 'state', 'approval-box-entries', 'harness-entries\.json'\), run: seatRun \}\)/u)
  assert.match(runtime, /services\.seatEntries\?\.start\(\)/u)
  assert.match(runtime, /services\.seatEntries\?\.close\(\)/u)
})
