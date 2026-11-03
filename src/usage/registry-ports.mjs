import { HARNESS, GUIDE_BOT_ID } from '../onboarding.mjs'
import { usageError } from './process-schema.mjs'

const object = value => value && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.length > 0
function members(value) {
  if (!Array.isArray(value)) throw usageError('USAGE_MEMBERS_INVALID')
  const result = new Map()
  for (const item of value) {
    if (!object(item) || Object.keys(item).sort().join(',') !== 'harness,id,name' || !text(item.id) || !text(item.name)
      || !(item.harness === null || Object.hasOwn(HARNESS, item.harness)) || result.has(item.id)) throw usageError('USAGE_MEMBERS_INVALID')
    result.set(item.id, { ...item })
  }
  return result
}

// Parent resolves projects and resources; this child port carries only display/identity fields.
export function createUsageRegistryPorts({ effect, initialMembers }) {
  let profiles = members(initialMembers), currentRooms = new Map()
  const ensureGuide = async harness => {
    if (!Object.hasOwn(HARNESS, harness)) throw usageError('USAGE_INPUT_INVALID', 400)
    const result = members([await effect('onboarding.ensureGuide', { harness })])
    if (!result.has(GUIDE_BOT_ID) || result.get(GUIDE_BOT_ID).harness !== harness) throw usageError('USAGE_MEMBERS_INVALID')
    const item = result.get(GUIDE_BOT_ID); profiles.set(item.id, item); return { ...item }
  }
  return {
    bots: {
      get size() { return profiles.size },
      async refresh() { profiles = members(await effect('members.read', {})) },
      get: id => profiles.has(id) ? { ...profiles.get(id) } : undefined,
      has: id => profiles.has(id), *values() { for (const item of profiles.values()) yield { ...item } },
      create: (input, options) => {
        if (options?.id !== GUIDE_BOT_ID) throw usageError('USAGE_EFFECT_INVALID')
        return ensureGuide(input.harness)
      },
      update: (id, input) => {
        if (id !== GUIDE_BOT_ID || !object(input) || Object.keys(input).join(',') !== 'harness') throw usageError('USAGE_EFFECT_INVALID')
        return ensureGuide(input.harness)
      },
    },
    rooms: {
      async refresh() {
        const rows = await effect('rooms.read', {})
        if (!Array.isArray(rows)) throw usageError('USAGE_ROOMS_INVALID')
        const next = new Map()
        for (const room of rows) {
          if (!object(room) || Object.keys(room).sort().join(',') !== 'id,memberIds' || !text(room.id)
            || !Array.isArray(room.memberIds) || room.memberIds.some(id => !text(id)) || next.has(room.id)) throw usageError('USAGE_ROOMS_INVALID')
          next.set(room.id, structuredClone(room))
        }
        currentRooms = next
      },
      get: id => currentRooms.has(id) ? structuredClone(currentRooms.get(id)) : undefined,
    },
  }
}
