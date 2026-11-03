import { createConversationChildChannel } from '../../src/conversation-ipc.mjs'
import { createConversationDispatcher } from '../../src/conversation/dispatcher.mjs'

// Test-only root injection; the product entry keeps its fixed root and lock checks.
let channel
const dispatcher = createConversationDispatcher({ root: process.argv[2], effect: (...args) => channel.effect(...args),
  event: (...args) => channel.event(...args), trackBackground: (...args) => channel.trackBackground(...args),
  diagnostic: (...args) => channel.diagnostic(...args) })
channel = createConversationChildChannel({ dispatcher, versionId: null })
