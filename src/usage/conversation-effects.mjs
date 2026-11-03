const invalid = () => Object.assign(new Error('CONVERSATION_USAGE_INPUT_INVALID'), {
  code: 'CONVERSATION_USAGE_INPUT_INVALID', outcome: 'not_accepted',
})

function fields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw invalid()
}

function strings(value, keys) {
  fields(value, keys)
  if (keys.some(key => typeof value[key] !== 'string' || !value[key] || value[key].includes('\0'))) throw invalid()
}

// The caller must authorize the registered conversation operation before dispatch.
export function createConversationUsage({ settings, notifications }) {
  const routingState = () => settings.routingState()
  return {
    routingState,
    async dispatch(method, params) {
      if (method === 'usage.routing.read') {
        fields(params, [])
        const state = routingState()
        const apiKey = state.enabled ? settings.configuration('routing').apiKey : null
        return { enabled: state.enabled, epoch: state.epoch, apiKey: typeof apiKey === 'string' && apiKey.trim() ? apiKey : null }
      }
      if (method === 'usage.notify.direct') {
        strings(params, ['deliveryId', 'from', 'target'])
        notifications.direct({ schema: 'bellteam.direct-message.v1', delivery_id: params.deliveryId, from: params.from, target: params.target })
        return { accepted: true }
      }
      if (method === 'usage.notify.room') {
        fields(params, ['id', 'sender', 'room'])
        if (typeof params.id !== 'string' || !params.id || params.id.includes('\0')) throw invalid()
        strings(params.sender, ['id', 'name'])
        strings(params.room, ['id', 'name'])
        notifications.room({ id: params.id, sender: { id: params.sender.id, name: params.sender.name }, room: { id: params.room.id, name: params.room.name } })
        return { accepted: true }
      }
      throw invalid()
    },
  }
}
