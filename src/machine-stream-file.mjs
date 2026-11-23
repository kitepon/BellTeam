import { open } from 'node:fs/promises'

// Line reads of one state/machine-stream/<botId>.jsonl (conversation/machine-stream.md, "The body holds a window").
// The file is append-only: every function reads a byte range and keeps nothing.
const BLOCK = 1 << 20
const NEWLINE = 10

const split = buffer => {
  const lines = []
  let start = 0
  for (let i = buffer.indexOf(NEWLINE); i >= 0; i = buffer.indexOf(NEWLINE, start)) {
    if (i > start) lines.push(buffer.subarray(start, i))
    start = i + 1
  }
  if (start < buffer.length) lines.push(buffer.subarray(start))
  return lines
}

async function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await fd.read(buffer, 0, length, position)
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead)
}

// Lines from `end` back to the start of the file: one array per block, in file order inside it, the newest block first.
// `end` is the end of the file or the start of a line. A last line without its newline is a line (the caller drops it when torn).
export async function* backward(path, end) {
  const fd = await open(path, 'r')
  try {
    let position = end, rest = Buffer.alloc(0)
    while (position > 0) {
      const from = Math.max(0, position - BLOCK), data = await readAt(fd, from, position - from)
      if (data.length !== position - from) return // the file shrank under us: what is read is all there is
      const all = rest.length ? Buffer.concat([data, rest]) : data
      const cut = from === 0 ? 0 : all.indexOf(NEWLINE) + 1 // the bytes before it end a line that began in an earlier block
      position = from
      if (from > 0 && cut === 0) { rest = all; continue }
      rest = all.subarray(0, cut)
      const lines = split(all.subarray(cut))
      if (lines.length) yield lines
    }
  } finally { await fd.close() }
}

// Complete lines (ended by a newline) from byte `start` up to `end`, each with the offset where it starts.
export async function* forward(path, start, end) {
  const fd = await open(path, 'r')
  try {
    let position = start, rest = Buffer.alloc(0), restAt = start
    while (position < end) {
      const data = await readAt(fd, position, Math.min(BLOCK, end - position))
      if (!data.length) return
      position += data.length
      const all = rest.length ? Buffer.concat([rest, data]) : data
      let from = 0
      for (let i = all.indexOf(NEWLINE); i >= 0; i = all.indexOf(NEWLINE, from)) {
        if (i > from) yield { offset: restAt + from, line: all.subarray(from, i) }
        from = i + 1
      }
      rest = all.subarray(from)
      restAt += from
    }
  } finally { await fd.close() }
}

// {seq, type, at} of a stored line without parsing the whole of it (a record is written as {"seq":N,"type":"..","at":"..",...}).
const HEAD = /^\{"seq":(\d+),"type":"([a-z]+)","at":"([^"]*)"/u
export function head(line) {
  const found = HEAD.exec(line.toString('latin1', 0, 160))
  if (found) return { seq: Number(found[1]), type: found[2], at: found[3] }
  const record = parseRecord(line)
  return record ? { seq: record.seq, type: record.type, at: record.at ?? '' } : null
}

export function parseRecord(line) {
  try {
    const record = JSON.parse(line.toString())
    return Number.isInteger(record?.seq) && typeof record.type === 'string' ? record : null
  } catch { return null }
}
