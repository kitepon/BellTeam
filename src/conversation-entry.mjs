import { createConversationChildChannel, verifyConversationLocks } from './conversation-ipc.mjs'
import { createConversationDispatcher } from './conversation/dispatcher.mjs'

try {
  verifyConversationLocks()
  let channel
  const dispatcher = createConversationDispatcher({ root: '/srv/bellteam',
    effect: (...args) => channel.effect(...args), event: (...args) => channel.event(...args),
    trackBackground: (...args) => channel.trackBackground(...args), diagnostic: report => channel.diagnostic(report) })
  channel = createConversationChildChannel({ dispatcher })
} catch {
  process.stderr.write('CONVERSATION_START_FAILED\n')
  process.exitCode = 1
  if (process.connected) process.disconnect()
}
