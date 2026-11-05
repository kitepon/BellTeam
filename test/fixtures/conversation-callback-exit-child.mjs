import { createConversationChildChannel } from '../../src/conversation-ipc.mjs'
import { CONVERSATION_STATE_COMPATIBILITY } from '../../src/conversation/state-compatibility.mjs'

// Local fault fixture: the real peer runs a callback effect until the parent requests exit zero.
process.once('SIGUSR2', () => process.exit(0))
let channel
const dispatcher = {
  validateRequest() {}, validateCallback() {}, disconnect() {}, releaseDelivery() {},
  async control(method) {
    if (method === 'initialize') return { stateCompatibility: CONVERSATION_STATE_COMPATIBILITY }
    return { [({ resume: 'resumed', quiesce: 'quiesced', exit: 'closed' })[method]]: true }
  },
  async dispatch(method, params, context) {
    if (method === 'rooms.list') return { rooms: [] }
    const deliveryId = 'cycle-delivery'
    await channel.effect('execution.notify', { deliveryId, target: params.target, message: params.message, images: [],
      kinds: ['delivery.status'], queue: { context: 'direct', contextId: params.target, groupId: deliveryId,
        from: params.from, fromName: 'Fixture', target: params.target, message: params.message } }, context)
    return { delivery: 'running', delivery_id: deliveryId, from: params.from, target: params.target }
  },
  async dispatchCallback(_method, _params, context) {
    await channel.effect('members.profiles.read', {}, context)
    return { applied: true }
  },
}
channel = createConversationChildChannel({ dispatcher, versionId: null })
