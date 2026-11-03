import { isDeepStrictEqual } from 'node:util'

// Writer formats and the existing reader ABI; this does not authorize migration.
export const CONVERSATION_STATE_COMPATIBILITY = Object.freeze({
  directRecordSchemas: Object.freeze(['bellteam.direct-message.v1', 'bellteam.interim-word.v1', 'bellteam.delivery-status.v1']),
  roomRecordSchemas: Object.freeze(['bellteam.room-message.v1', 'bellteam.room-routing-status.v1', 'bellteam.room-delivery-status.v1']),
  roomSchema: 'bellteam.room.v1',
  scheduleSchema: 'bellteam.schedule.v1',
  selfTurnsSchema: 'bellteam.self-turns.v1',
  imageMimeTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  readerContract: 'bellteam.conversation-reader.v1',
})

export function assertConversationStateCompatibility(value) {
  if (!isDeepStrictEqual(value, CONVERSATION_STATE_COMPATIBILITY))
    throw Object.assign(new Error('CONVERSATION_STATE_INCOMPATIBLE'), { code: 'CONVERSATION_STATE_INCOMPATIBLE' })
}
