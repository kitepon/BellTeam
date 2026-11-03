import { readConversationJson, conversationStreamError } from './conversation-streams.mjs'

const SMALL = 64 * 1024, MAX = 96 * 1024 * 1024 + SMALL

// Claimed before credit is issued; the channel releases only after real dispatch/body cleanup.
export function createConversationInputBudget() {
  let large = null
  return {
    claim(meta) {
      if (meta.lane !== 'root') return true
      if (!Number.isSafeInteger(meta.length) || meta.length < 0 || meta.length > MAX) return false
      if (meta.length <= SMALL) return true
      if (large !== null) return false
      large = meta.operation; return true
    },
    read(meta, chunks) {
      if (meta.lane !== 'root' || !Number.isSafeInteger(meta.length) || meta.length < 0 || meta.length > MAX
        || meta.length > SMALL && large !== meta.operation) throw conversationStreamError('CONVERSATION_INPUT_NOT_RESERVED')
      return readConversationJson(chunks, meta.length)
    },
    release(meta) { if (large === meta.operation && meta.lane === 'root') large = null },
  }
}
