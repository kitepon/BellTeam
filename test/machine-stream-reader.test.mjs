import assert from 'node:assert/strict'
import test from 'node:test'
import { MachineStreamReaders } from '../src/machine-stream-reader.mjs'

const idle = { state: 'idle', reason: null, pending: [] }
// A scripted stream_read: each step is a result or an Error; after the script the reader is stopped.
function rig(steps, { ingest = async () => ({ status: 'stored' }), saved = null } = {}) {
  const calls = [], sent = []
  let readers
  const client = { async call(name, args) {
    assert.equal(name, 'stream_read')
    calls.push(args)
    const step = steps.shift()
    if (!step) { readers.stop('s1'); return { structuredContent: { launch_id: 'L', lines: [], cursor: 'L:0', state: idle } } }
    if (step instanceof Error) throw step
    return { structuredContent: step }
  } }
  const port = { cursor: async () => saved, ingest: async envelope => { sent.push(envelope); return ingest(envelope) } }
  readers = new MachineStreamReaders({ client, port, sleep: async () => {} })
  const done = new Promise(resolve => { const finish = readers.readers.delete.bind(readers.readers); readers.readers.delete = key => { finish(key); resolve() } })
  return { readers, calls, sent, done, start: () => readers.start({ id: 'bot-a' }, 's1') }
}
const read = (lines, cursor, state = idle, launch_id = 'L') => ({ launch_id, lines, cursor, state })

test('a471 stream: lines go to conversation unchanged and the cursor moves only on stored', async () => {
  const r = rig([read(['{"a":1}', '{"b":2}'], 'L:10'), read(['{"c":3}'], 'L:20')])
  r.start(); await r.done
  assert.deepEqual(r.sent.map(e => [e.cursor_from, e.cursor_after, e.lines]), [[null, 'L:10', ['{"a":1}', '{"b":2}']], ['L:10', 'L:20', ['{"c":3}']]])
  assert.deepEqual(r.calls.map(c => c.cursor ?? null), [null, 'L:10', 'L:20'])
  assert.equal(r.sent[0].botId, 'bot-a'); assert.equal(r.sent[0].session, 's1'); assert.equal(r.sent[0].launch_id, 'L')
})

test('a471 stream: resync reads again from the cursor conversation names; an Aiterm stale cursor restarts at the launch start', async () => {
  let first = true
  const r = rig([read(['x'], 'L:5'), read(['y'], 'M:9', idle, 'M'), read(['z'], 'M:12', idle, 'M')], { ingest: async () => first ? (first = false, { status: 'resync', cursor: 'L:1' }) : { status: 'stored' } })
  r.start(); await r.done
  assert.deepEqual(r.calls.map(c => c.cursor ?? null).slice(0, 3), [null, 'L:1', 'M:9'])
  const stale = Object.assign(new Error('aiterm: STREAM_CURSOR_STALE: x'), { aitermResponseReturned: true })
  const s = rig([read(['a'], 'L:5'), stale, read(['b'], 'N:3', idle, 'N')])
  s.start(); await s.done
  assert.deepEqual(s.calls.map(c => c.cursor ?? null).slice(0, 3), [null, 'L:5', null], 'after the stale answer the read starts over')
  assert.equal(s.sent.at(-1).cursor_from, null)
})

test('a471 stream: a state change alone is sent (closes cards), an unchanged state is not, exited ends the reader, a saved cursor is used', async () => {
  const pending = { state: 'blocked', reason: 'unknown_dialog', pending: [{ request_id: 'r1', subtype: 'can_use_tool', tool_name: 'AskUserQuestion' }] }
  const r = rig([read([], 'L:0', pending), read([], 'L:0', pending), read([], 'L:0', idle), read(['bye'], 'L:3', { state: 'exited', reason: null, pending: [] }), read([], 'L:3', idle)],
    { saved: { session: 's1', launch_id: 'L', cursor: 'L:0' } })
  r.start(); await r.done
  assert.deepEqual(r.sent.map(e => [e.lines.length, e.state.state]), [[0, 'blocked'], [0, 'idle'], [1, 'exited']])
  assert.equal(r.calls[0].cursor, 'L:0', 'the stored cursor of the same session')
  assert.equal(r.calls.length, 4, 'nothing is read after exited')
})

test('a471 stream: a drained previous launch hands over to the current launch; a seat without stream tools ends the reader', async () => {
  const exited = { state: 'exited', reason: null, pending: [] }
  const old = (lines, cursor, at_end) => ({ ...read(lines, cursor, exited, 'L'), current_launch_id: 'M', at_end })
  const r = rig([old(['a'], 'L:5', false), old(['b'], 'L:9', true), read(['c'], 'M:3', idle, 'M')])
  r.start(); await r.done
  assert.deepEqual(r.calls.map(c => c.cursor ?? null).slice(0, 3), [null, 'L:5', null], 'once the old launch is drained (at_end) the next read starts at the current launch')
  assert.equal(r.sent.at(-1).launch_id, 'M'); assert.equal(r.sent.at(-1).cursor_from, null)
  const unsupported = Object.assign(new Error('aiterm: STREAM_UNSUPPORTED: not a stream seat'), { aitermResponseReturned: true })
  const u = rig([unsupported]); u.start(); await u.done
  assert.equal(u.calls.length, 1, 'no retry for a seat that has no stream')
})

test('a471 stream: an unreachable read waits and retries from the same cursor, and a vanished seat ends the reader', async () => {
  const r = rig([read(['a'], 'L:1'), new Error('boom'), read(['b'], 'L:2')])
  r.start(); await r.done
  assert.deepEqual(r.calls.map(c => c.cursor ?? null).slice(0, 3), [null, 'L:1', 'L:1'])
  let reads = 0
  const client = { async call() { reads++; throw new Error('no seat') } }
  const readers = new MachineStreamReaders({ client, port: { cursor: async () => null, ingest: async () => ({ status: 'stored' }) }, sleep: async () => {}, gone: async () => true })
  readers.start({ id: 'bot-a' }, 's2')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(reads, 1); assert.equal(readers.readers.size, 0)
  // no port = no reader
  const none = new MachineStreamReaders({ client, port: null }); none.start({ id: 'bot-a' }, 's3'); assert.equal(none.readers.size, 0)
})

test('a471 reader-resume: stopAll gives up a reader without ingesting the poll that was running, and start replaces a stopped reader', async () => {
  const sent = []
  let readers, calls = 0
  const client = { async call() {
    calls++
    if (calls === 1) { readers.stopAll(); return { structuredContent: { launch_id: 'L', lines: ['late'], cursor: 'L:1', state: idle } } }
    if (calls === 2) return { structuredContent: { launch_id: 'L', lines: ['again'], cursor: 'L:2', state: idle } }
    readers.stop('s1'); return { structuredContent: { launch_id: 'L', lines: [], cursor: 'L:2', state: idle } }
  } }
  readers = new MachineStreamReaders({ client, port: { cursor: async () => null, ingest: async e => (sent.push(e), { status: 'stored' }) }, sleep: async () => {} })
  const finished = () => new Promise(resolve => { const del = readers.readers.delete.bind(readers.readers); readers.readers.delete = key => { del(key); resolve() } })
  let done = finished(); readers.start({ id: 'bot-a' }, 's1'); await done
  assert.deepEqual(sent, [], 'a stopped reader hands nothing to conversation')
  readers.start({ id: 'bot-a' }, 's1') // the resumed engine: no stale entry blocks it
  done = finished(); readers.readers.get('s1') && await done
  assert.deepEqual(sent.map(e => e.lines), [['again']])
})
