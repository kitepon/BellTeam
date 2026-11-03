import { createConversationChildChannel } from '../../src/conversation-ipc.mjs'
import { createConversationDispatcher } from '../../src/conversation/dispatcher.mjs'

// Test-only root injection; the product entry keeps its fixed root and lock checks.
let channel
const dispatcher = createConversationDispatcher({ root: process.argv[2], effect: (...args) => channel.effect(...args),
  event: (...args) => channel.event(...args), trackBackground: (...args) => channel.trackBackground(...args),
  diagnostic: (...args) => channel.diagnostic(...args) })
channel = createConversationChildChannel({ dispatcher: process.argv[4] ? { ...dispatcher, control: async (...args) => {
  if (args[0] === 'quiesce') await new Promise(resolve => setTimeout(resolve, Number(process.argv[4])))
  return dispatcher.control(...args)
} } : dispatcher, versionId: process.argv[3] && process.argv[3] !== 'builtin' ? process.argv[3] : null })
