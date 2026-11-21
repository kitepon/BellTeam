import { readConversationJson, conversationStreamError } from './conversation-streams.mjs'

const SMALL = 64 * 1024, MAX = 96 * 1024 * 1024 + SMALL

// One root body over 64 KiB is rebuilt at a time (memory). A second one WAITS for the slot, never refused: the page read of a long
// machine stream is over 64 KiB, and refusing it showed the Owner CONVERSATION_INPUT_BUSY (a471-read-busy-503).
// Self-exit: release() hands the slot to the next waiter. Waiters hold at most the stream window (4 chunks) each, and the
// stream's own 60 s no-progress rule still applies to a waiter.
export function createConversationInputBudget() {
  let large = null
  const waiting = []
  const grant = () => { if (large === null && waiting.length) { const next = waiting.shift(); large = next.operation; next.resolve() } }
  const valid = meta => meta.lane === 'root' && Number.isSafeInteger(meta.length) && meta.length >= 0 && meta.length <= MAX
  return {
    // Size only: a body over the protocol limit is refused before credit is issued.
    claim(meta) { return meta.lane !== 'root' || valid(meta) },
    async read(meta, chunks) {
      if (!valid(meta)) throw conversationStreamError('CONVERSATION_INPUT_NOT_RESERVED')
      if (meta.length > SMALL) {
        if (large === null && !waiting.length) large = meta.operation
        else await new Promise(resolve => waiting.push({ operation: meta.operation, resolve }))
      }
      return readConversationJson(chunks, meta.length)
    },
    release(meta) {
      if (meta.lane !== 'root') return
      const queued = waiting.findIndex(item => item.operation === meta.operation)
      if (queued >= 0) waiting.splice(queued, 1)
      if (large === meta.operation) { large = null; grant() }
    },
  }
}
