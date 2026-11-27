import assert from 'node:assert/strict'
import test from 'node:test'
import { MachineStreamReaders } from '../src/machine-stream-reader.mjs'
import { AitermTransport } from '../src/aiterm-transport.mjs'

const idle = { state: 'idle', reason: null, pending: [] }

test('idleFor counts only a current, fresh idle read and restarts after a busy one', async () => {
  const steps = [{ state: idle }, { state: { state: 'running', pending: [] } }, { state: idle }, { state: { state: 'idle', pending: [{ request_id: 'r' }] } }]
  let readers
  const client = { async call() {
    const step = steps.shift()
    if (!step) { readers.stop('s1'); return { structuredContent: { launch_id: 'L', lines: [], cursor: 'L:0', state: idle } } }
    return { structuredContent: { launch_id: 'L', lines: [], cursor: 'L:0', ...step } }
  } }
  readers = new MachineStreamReaders({ client, port: { cursor: async () => null, ingest: async () => ({ status: 'stored' }) }, sleep: async () => {} })
  assert.equal(readers.idleFor('s1'), null, 'no reader, no claim')
  const seen = []
  const real = readers.port.ingest
  readers.port.ingest = async e => { seen.push(readers.idleFor('s1')); return real(e) }
  readers.start({ id: 'bot-a' }, 's1')
  await new Promise(resolve => { const del = readers.readers.delete.bind(readers.readers); readers.readers.delete = k => { del(k); resolve() } })
  assert.equal(seen.length, 4)
  const r = { idleSince: 1000, seenAt: 100_000 }
  readers.readers.set('s2', r)
  assert.equal(readers.idleFor('s2', 101_000), 100_000, 'fresh read: the idle duration')
  assert.equal(readers.idleFor('s2', 160_001), null, 'a read older than two long polls proves nothing')
  r.idleSince = null; assert.equal(readers.idleFor('s2', 101_000), null, 'busy')
})

test('a wait that keeps answering running ends once the seat stream has been idle for two minutes, and not before', async () => {
  let idleMs = null, waits = 0
  const transport = new AitermTransport({ client: { async call() { throw new Error('unexpected') } }, handoffContext: async () => '',
    waitProcess: async () => { waits++; await new Promise(resolve => setTimeout(resolve, 2)); return { outcome: 'running' } } })
  transport.machineStreams.idleFor = () => idleMs
  const receipt = { session_id: 's1', wait_process: { executable: '/node', args: [] } }
  const first = transport.waitUntilDone(receipt, null, 's1')
  const stop = new AbortController()
  idleMs = 119_000
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(waits > 1, 'under the settle time the wait goes on')
  idleMs = 120_000
  await assert.rejects(first, error => error.message.startsWith('AITERM_TURN_UNSETTLED') && error.waitOutcome === 'unsettled' && !error.turnCompleted)
  idleMs = null
  const quiet = transport.waitUntilDone(receipt, stop.signal, 's1')
  await new Promise(resolve => setTimeout(resolve, 20))
  stop.abort()
  await assert.rejects(quiet, /AITERM_WAIT_STOPPED/)
})
