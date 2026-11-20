import assert from 'node:assert/strict'
import test from 'node:test'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { MachineStreamReaders } from '../src/machine-stream-reader.mjs'

// execution machine-stream.md "Display source": a machine seat's words are drawn from the stream, so followInterim relays only errors.
const words = [{ seq: 1, text: 'looking', kind: 'interim' }, { seq: 2, text: 'rate limit', kind: 'error' }, { seq: 3, text: 'done', kind: 'answer' }]
async function relayed(port, readerSession) {
  const transport = new AitermTransport({ interimInterval: 1, seatStream: port, client: { async call() { assert.fail('no Aiterm call') } } })
  if (readerSession) transport.machineStreams.readers.set(readerSession, { stopped: false })
  transport.readInterim = async () => ({ event_cursor: 1, words })
  const seen = []
  const follow = transport.followInterim('s1', { event_cursor: 1 }, async value => { seen.push(...value.map(word => word.kind)) })
  const result = await follow.stop()
  return { seen, error: result.error }
}

test('displays() needs the conversation flag and a running reader', () => {
  const readers = new MachineStreamReaders({ client: {}, port: { displayFromStream: true } })
  assert.equal(readers.displays('s1'), false)
  readers.readers.set('s1', { stopped: false })
  assert.equal(readers.displays('s1'), true)
  assert.equal(readers.displays('fork'), false)
  const old = new MachineStreamReaders({ client: {}, port: {} }); old.readers.set('s1', {})
  assert.equal(old.displays('s1'), false)
  assert.equal(new MachineStreamReaders({ client: {} }).displays('s1'), false)
})

test('followInterim relays only errors for a seat whose stream is read, everything otherwise', async () => {
  const port = { cursor: async () => null, ingest: async () => ({ status: 'stored' }), displayFromStream: true }
  assert.deepEqual(await relayed(port, 's1'), { seen: ['error'], error: true })
  assert.deepEqual((await relayed(port, null)).seen, ['interim', 'error', 'answer'], 'a fork or TUI seat has no reader')
  assert.deepEqual((await relayed({ ...port, displayFromStream: undefined }, 's1')).seen, ['interim', 'error', 'answer'], 'old conversation: no flag')
})
