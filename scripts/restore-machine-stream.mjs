#!/usr/bin/env node
// mstream-archive-20261124: put the history back that a cut removed from state/machine-stream/<botId>.jsonl.
//   node restore-machine-stream.mjs <archiveDir> <liveDir> [--apply] [--only bot-a,bot-b]
// The archive file is the original; the live file is its newest part plus everything stored after the cut. The restored file is
//   the whole archive file + the live file's records with seq greater than the archive's last seq,
// after three checks per file: every live record that the archive also has is byte-identical, the records after the join continue
// the archive's last seq by one, and seq grows by one from there. Without --apply nothing is written (a report only).
// The swap is one atomic rename over the live path (the body opens the path for each append, so it writes to the new file from then on);
// bytes the body appended while the copy ran are copied before the rename, and the replaced file is kept as <botId>.jsonl.cut-<stamp>.
import { createHash } from 'node:crypto'
import { chmod, chown, link, open, readdir, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const BLOCK = 1 << 20
const [archiveDir, liveDir, ...flags] = process.argv.slice(2)
if (!archiveDir || !liveDir) { process.stderr.write('usage: restore-machine-stream.mjs <archiveDir> <liveDir> [--apply] [--only bot-a,bot-b]\n'); process.exit(2) }
const apply = flags.includes('--apply')
const only = flags.includes('--only') ? new Set(flags[flags.indexOf('--only') + 1].split(',')) : null
const stamp = new Date().toISOString().replace(/\D/gu, '').slice(0, 14)

// Complete lines of a file from `start`: { offset, end, text } (end = offset after the newline). A last line without a newline is not returned.
async function* lines(path, start = 0, stop = Infinity) {
  const fd = await open(path, 'r')
  try {
    let position = start, rest = Buffer.alloc(0), restAt = start
    const size = Math.min((await fd.stat()).size, stop)
    while (position < size) {
      const data = Buffer.alloc(Math.min(BLOCK, size - position))
      const { bytesRead } = await fd.read(data, 0, data.length, position)
      if (!bytesRead) return
      position += bytesRead
      const all = rest.length ? Buffer.concat([rest, data.subarray(0, bytesRead)]) : data.subarray(0, bytesRead)
      let from = 0
      for (let i = all.indexOf(10); i >= 0; i = all.indexOf(10, from)) {
        yield { offset: restAt + from, end: restAt + i + 1, text: all.subarray(from, i) }
        from = i + 1
      }
      rest = all.subarray(from); restAt += from
    }
  } finally { await fd.close() }
}

const seqOf = text => { try { const record = JSON.parse(text.toString()); return Number.isInteger(record?.seq) ? record.seq : null } catch { return null } }
const sha = text => createHash('sha1').update(text).digest('hex')

// What one Bot's restore is made of, or why it cannot be.
async function plan(botId) {
  const archive = join(archiveDir, `${botId}.jsonl`), live = join(liveDir, `${botId}.jsonl`)
  let archiveEnd = 0, last = 0
  for await (const line of lines(archive)) { const seq = seqOf(line.text); if (seq === null) return { botId, fail: `archive: unreadable line at byte ${line.offset}` }; if (seq <= last) return { botId, fail: `archive: seq ${seq} after ${last}` }; last = seq; archiveEnd = line.end }
  if (!last) return { botId, fail: 'archive: no record' }
  let first = null
  for await (const line of lines(live)) { const seq = seqOf(line.text); if (seq !== null) { first = seq; break } } // the first line may be a cut one
  if (first === null) return { botId, fail: 'live: no record' }
  if (first > last + 1) return { botId, fail: `live starts at seq ${first}, after the archive's last ${last} + 1: history between them is missing` }
  const known = new Map()
  for await (const line of lines(archive)) { const seq = seqOf(line.text); if (seq >= first) known.set(seq, sha(line.text)) }
  let joinAt = null, overlap = 0, added = 0, previous = null
  for await (const line of lines(live)) {
    const seq = seqOf(line.text)
    if (seq === null) { if (previous === null) continue; return { botId, fail: `live: unreadable line at byte ${line.offset}` } } // only a first line cut in two is skipped
    if (previous !== null && seq !== previous + 1) return { botId, fail: `live: seq ${seq} after ${previous}` }
    previous = seq
    if (seq <= last) { if (known.get(seq) !== sha(line.text)) return { botId, fail: `seq ${seq} differs between archive and live` }; overlap++; continue }
    if (joinAt === null) { if (seq !== last + 1) return { botId, fail: `after the join seq is ${seq}, expected ${last + 1}` }; joinAt = line.offset }
    added++
  }
  return { botId, archive, live, archiveEnd, last, first, overlap, added, joinAt, liveSize: (await stat(live)).size }
}

async function copy(from, to, start, end) {
  const input = await open(from, 'r')
  try {
    for (let position = start; position < end;) {
      const data = Buffer.alloc(Math.min(BLOCK, end - position))
      const { bytesRead } = await input.read(data, 0, data.length, position)
      if (!bytesRead) throw new Error(`short read of ${from} at ${position}`)
      await to.write(data, 0, bytesRead); position += bytesRead
    }
  } finally { await input.close() }
}

// Write prefix segments [{file, start, end}] and then the live path's bytes from `from` on to a new file, and put it over the live path.
// The body keeps appending: the tail is copied in rounds, the last one right before the rename. Returns where the tail was copied to.
async function swap(item, prefix, from, stampName) {
  const temp = `${item.live}.restore-${stampName}`, mode = await stat(item.live)
  const output = await open(temp, 'wx', mode.mode & 0o777)
  let copied = from
  try {
    for (const { file, start, end } of prefix) await copy(file, output, start, end)
    for (let round = 0; round < 20; round++) {
      const size = (await stat(item.live)).size
      if (size === copied) break
      await copy(item.live, output, copied, size); copied = size
    }
    await output.sync()
  } finally { await output.close() }
  try { await chown(temp, mode.uid, mode.gid) } catch { /* not allowed unless root: the owner is then the user who ran this */ }
  await chmod(temp, mode.mode & 0o777)
  const kept = `${item.live}.cut-${stampName}`
  await link(item.live, kept) // the replaced file stays reachable (a write that was in flight lands there)
  const last = (await stat(item.live)).size
  if (last > copied) { // the last bytes: the rename follows at once
    const again = await open(temp, 'a'); try { await copy(item.live, again, copied, last) } finally { await again.close() }
    copied = last
  }
  await rename(temp, item.live)
  return { kept, copied }
}

async function restore(item) {
  const joinAt = item.joinAt ?? item.liveSize
  let { kept, copied } = await swap(item, [{ file: item.archive, start: 0, end: item.archiveEnd }], joinAt, `${stamp}a`)
  let base = item.archiveEnd + (copied - joinAt) // where, in the file now at the live path, what the body wrote after the rename begins
  const replaced = [kept]
  // A write that was in flight when the file was replaced lands in the replaced file, after what was copied, and its records come before
  // the ones the body wrote to the new file since: put them in between (every offset is known), and look again, until nothing strays.
  for (let pass = 1; pass <= 5; pass++) {
    await new Promise(done => setTimeout(done, 1500))
    const strayed = (await stat(kept)).size - copied
    if (strayed <= 0) return { kept: replaced.join(', '), strayed: 0 }
    const next = await swap(item, [{ file: item.live, start: 0, end: base }, { file: kept, start: copied, end: copied + strayed }], base, `${stamp}${'bcdef'[pass - 1]}`)
    replaced.push(next.kept)
    base = next.copied + strayed; kept = next.kept; copied = next.copied
  }
  return { kept: replaced.join(', '), strayed: (await stat(kept)).size - copied }
}

const names = (await readdir(archiveDir)).filter(name => name.endsWith('.jsonl')).map(name => name.slice(0, -6)).filter(botId => !only || only.has(botId)).sort()
let failed = 0
for (const botId of names) {
  const item = await plan(botId).catch(error => ({ botId, fail: error.message }))
  if (item.fail) { failed++; process.stdout.write(`FAIL ${botId}: ${item.fail}\n`); continue }
  let done = ''
  if (apply) {
    const { kept, strayed } = await restore(item)
    done = strayed > 0 ? ` APPLIED, BUT ${strayed} bytes were written to the replaced file after the copy: check ${kept}` : ` applied (replaced file kept as ${kept})`
    if (strayed > 0) failed++
  }
  process.stdout.write(`${apply ? '' : 'plan '}OK ${botId}: archive ${item.last} records, live from seq ${item.first}, ${item.overlap} identical, ${item.added} new after the cut${done}\n`)
}
process.stdout.write(`${names.length - failed}/${names.length} ${apply ? 'applied' : 'can be restored'}\n`)
process.exit(failed ? 1 : 0)
