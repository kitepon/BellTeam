import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MachineStream } from '../src/machine-stream.mjs'

// mstream-archive-20261124: the history a cut removed is put back by scripts/restore-machine-stream.mjs, also while the body appends.
const run = promisify(execFile)
const script = new URL('../scripts/restore-machine-stream.mjs', import.meta.url).pathname
const bots = new Map([['bot-d', { id: 'bot-d', name: 'D' }], ['bot-e', { id: 'bot-e', name: 'E' }]])
const J = value => JSON.stringify(value)
const words = text => J({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const tick = () => { let n = 0; return () => new Date(Date.UTC(2026, 10, 24, 0, 0, n++)).toISOString() }

async function fill(ms, botId, count, first = 0, base = null) {
  let cursor = base
  for (let i = first; i < first + count; i++) {
    const after = `L1:${i}`
    await ms.ingest({ botId, session: 's', launch_id: 'L1', cursor_from: cursor, cursor_after: after, lines: [words(`${botId} ${i} ${'x'.repeat(i % 50)}`), words(`${botId} ${i} again`)], state: { state: 'busy', reason: null, pending: [] } })
    cursor = after
  }
  return cursor
}

const clock = tick() // one clock for every instance: stored times only grow, as they do in production
const make = (root, options = {}) => new MachineStream({ root, bots, streamSend: async () => ({}), now: clock, ...options })

async function scene(t) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-restore-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const live = join(root, 'state/machine-stream'), archive = join(root, 'state/machine-stream-archive')
  const body = make(root); await body.initialize()
  const cursors = { 'bot-d': await fill(body, 'bot-d', 300), 'bot-e': await fill(body, 'bot-e', 40) }
  await mkdir(archive, { recursive: true })
  for (const file of await readdir(live)) await copyFile(join(live, file), join(archive, file))
  // Bell's cut: the newest bytes of the big file, from the middle of a line (the small file is not cut)
  const path = join(live, 'bot-d.jsonl'), size = (await stat(path)).size, keep = 4000
  const input = await open(path, 'r'), tail = Buffer.alloc(keep); await input.read(tail, 0, keep, size - keep); await input.close()
  await writeFile(path, tail)
  return { root, live, archive, cursors, size }
}

test('restore: the archive plus what was stored after the cut, checked, with the older pages back', async t => {
  const { root, live, archive, cursors } = await scene(t)
  const reborn = make(root, { window: 6 }); await reborn.initialize() // the body after the cut: it sees the cut file only
  await fill(reborn, 'bot-d', 30, 300, cursors['bot-d'])
  const before = await reborn.page('bot-d', { limit: 1000 })
  const cutRows = (await reborn.page('bot-d', { limit: 1000, before: before.rows[0].id, hint: before.rows[0].at })).rows.length // builds its file index on the cut file
  const plan = await run('node', [script, archive, live])
  assert.match(plan.stdout, /OK bot-d: archive 600 records, live from seq \d+, \d+ identical, 60 new after the cut/)
  assert.match(plan.stdout, /OK bot-e: archive 80 records/)
  assert.equal((await stat(join(live, 'bot-d.jsonl'))).size < 40000, true, 'a plan writes nothing')
  const applied = await run('node', [script, archive, live, '--apply'])
  assert.match(applied.stdout, /applied/); assert.doesNotMatch(applied.stdout, /BUT/)
  assert.ok((await readdir(live)).filter(name => name.includes('.cut-')).length >= 2, 'the replaced files are kept')
  const restored = (await readFile(join(live, 'bot-d.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line).seq)
  assert.deepEqual(restored, Array.from({ length: 660 }, (_, i) => i + 1), 'every seq once, in order')
  // the running body (index built on the cut file) reads the restored file; a restarted body with a big window reads the same rows
  const all = async ms => { const rows = []; let page = await ms.page('bot-d', { limit: 1000 }); for (;;) { rows.unshift(...page.rows); if (!page.skipped || !page.rows.length) return rows; page = await ms.page('bot-d', { limit: 1000, before: page.rows[0].id, hint: page.rows[0].at }) } }
  const whole = make(root); await whole.initialize({ readOnly: true })
  const [running, reference] = [await all(reborn), await all(whole)]
  assert.equal(reference.length, 660)
  assert.ok(cutRows < 660)
  assert.deepEqual(running.map(row => row.id), reference.map(row => row.id))
})

test('restore: nothing is written when a check fails (a record that differs, a gap)', async t => {
  const { live, archive } = await scene(t)
  const other = join(live, '..', 'other'); await mkdir(other, { recursive: true })
  await writeFile(join(other, 'bot-d.jsonl'), (await readFile(join(live, 'bot-d.jsonl'), 'utf8')).replaceAll('again', 'AGAIN'))
  const changed = await run('node', [script, archive, other, '--apply']).catch(error => error)
  assert.match(changed.stdout, /FAIL bot-d: seq \d+ differs between archive and live/)
  assert.equal((await readdir(other)).length, 1)
  const gap = join(live, '..', 'gap'); await mkdir(gap, { recursive: true })
  const lines = (await readFile(join(live, 'bot-d.jsonl'), 'utf8')).split('\n').filter(Boolean)
  await writeFile(join(gap, 'bot-d.jsonl'), [...lines.slice(1, 5), JSON.stringify({ seq: 9000, type: 'line', at: 'x', line: '{}' })].join('\n') + '\n')
  assert.match((await run('node', [script, archive, gap, '--apply']).catch(error => error)).stdout, /FAIL bot-d: live: seq 9000 after/)
})

test('restore while the body appends: no record is lost', async t => {
  const { root, live, archive, cursors } = await scene(t)
  const reborn = make(root, { window: 6 }); await reborn.initialize()
  let cursor = cursors['bot-d'], next = 300, stop = false
  const writer = (async () => { while (!stop) { cursor = await fill(reborn, 'bot-d', 1, next++, cursor) } })()
  await new Promise(done => setTimeout(done, 100))
  const applied = await run('node', [script, archive, live, '--apply', '--only', 'bot-d']).catch(error => error)
  await new Promise(done => setTimeout(done, 300))
  stop = true; await writer
  assert.match(applied.stdout, /applied/)
  const seqs = (await readFile(join(live, 'bot-d.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line).seq)
  assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => i + 1), `seq 1..${seqs.length}, no gap`)
  assert.ok(seqs.length > 640, `${seqs.length} records`)
})

test('restore: a write that was in flight when the file was replaced is not lost, wherever it lands', async t => {
  const { live, archive } = await scene(t)
  const path = join(live, 'bot-d.jsonl')
  const held = await open(path, 'a') // an append that opened the old file before the rename
  const applying = run('node', [script, archive, live, '--apply', '--only', 'bot-d'])
  for (let i = 0; i < 2000 && !(await readdir(live)).some(name => name.includes('.cut-')); i++) await new Promise(done => setTimeout(done, 2)) // the replaced file is linked: the rename follows at once
  await held.write(J({ seq: 601, type: 'line', at: '2026-11-24T05:00:00.000Z', session: 's', launch_id: 'L1', cursor_after: 'L1:601', line: words('late') }) + '\n')
  await held.close()
  const result = await applying
  assert.doesNotMatch(result.stdout, /BUT/)
  const seqs = (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line).seq)
  assert.deepEqual(seqs, Array.from({ length: 601 }, (_, i) => i + 1)) // copied by the last round, or put back by the stray pass
})
