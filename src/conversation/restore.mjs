import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConversationStore } from '../conversation-store.mjs'
import { RoomRegistry } from '../room-registry.mjs'

export async function readSelfTurnsState(path) {
  let value
  try { value = JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error }
  const invalid = () => { throw Object.assign(new Error('CONVERSATION_SELF_STATE_INVALID'), { code: 'CONVERSATION_SELF_STATE_INVALID' }) }
  if (value?.schema !== 'bellteam.self-turns.v1' || !value.bots || typeof value.bots !== 'object' || Array.isArray(value.bots)) invalid()
  for (const state of Object.values(value.bots)) {
    if (!state || typeof state !== 'object' || Array.isArray(state)
      || !(state.cursor == null || typeof state.cursor === 'string')
      || !Array.isArray(state.seen) || state.seen.some(key => typeof key !== 'string')
      || !(state.lastCompletedAt == null || Number.isFinite(state.lastCompletedAt))) invalid()
  }
  return value.bots
}

export async function restoreConversationState({ root, bots }) {
  if (!(bots instanceof Map)) throw Object.assign(new Error('CONVERSATION_BOTS_SNAPSHOT_REQUIRED'), { code: 'CONVERSATION_BOTS_SNAPSHOT_REQUIRED' })
  const rooms = new RoomRegistry({ roomsRoot: join(root, 'rooms'), bots })
  await rooms.restore()
  const selfState = await readSelfTurnsState(join(root, 'logs/self-turns.json'))
  return { rooms, selfState, store: new ConversationStore({ logPath: join(root, 'logs/direct-messages.jsonl') }) }
}
