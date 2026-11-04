import { createConversationPeer } from '../../src/conversation-channel.mjs'
const mode = process.argv[2]
if (mode === 'sink_failure') process.stderr.write = () => { throw new Error('sink unavailable') }
const peer = createConversationPeer(process, { side: mode === 'parent' ? 'parent' : 'child',
  accept: () => () => ({}), validateResult: () => {} })
process.send('ready', () => {
  if (mode === 'parent_disconnect') return
  if (mode === 'exit' || mode === 'exitWriter') peer.close(mode)
  else peer.fail(Object.assign(new Error('private message must never be logged'), { code: mode }))
  peer.fail(Object.assign(new Error('later'), { code: 'CONVERSATION_IPC_TIMEOUT' }))
})
