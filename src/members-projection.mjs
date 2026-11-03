import { isDeepStrictEqual } from 'node:util'
import { validateMembersProjection } from './members/protocol.mjs'

const invalid = () => Object.assign(new Error('MEMBERS_PROJECTION_INVALID'), { code: 'MEMBERS_PROJECTION_INVALID', status: 503 })

// The channel validates live lease/initialize authority before forwarding a record.
export function createMembersProjection({ onChange = () => {} } = {}) {
  let generation = null, targetGeneration = null, revision = null, available = false, pending = null
  let profiles = new Map()
  return {
    begin(nextGeneration) {
      if (typeof nextGeneration !== 'string' || !nextGeneration || nextGeneration === targetGeneration) throw invalid()
      targetGeneration = nextGeneration; available = false; pending = null
    },
    accept(record, context) {
      let changed = false
      try {
        validateMembersProjection(record, context)
        if (context.leaseId === null && context.continuation !== false) throw invalid()
        if (context.generation !== targetGeneration) throw invalid()
        if (record.type === 'snapshot-start') {
          if (pending || generation === targetGeneration && revision !== null && record.revision <= revision) throw invalid()
          pending = { revision: record.revision, profiles: new Map() }
          return
        }
        if (!pending || pending.revision !== record.revision) throw invalid()
        if (record.type === 'profile') {
          if (pending.profiles.has(record.bot.id) || ['avatar', 'avatarLarge', 'avatarSource', 'avatarLargeSource'].some(key => Object.hasOwn(record.bot, key))) throw invalid()
          pending.profiles.set(record.bot.id, structuredClone(record.bot))
          return
        }
        changed = !available || generation !== targetGeneration || !isDeepStrictEqual(profiles, pending.profiles)
        profiles = pending.profiles; generation = targetGeneration; revision = pending.revision; pending = null; available = true
      } catch (error) {
        pending = null; available = false
        throw error
      }
      if (changed) onChange()
    },
    unavailable() { pending = null; available = false },
    snapshot() { return { generation, revision, available, stale: !available, profiles: [...profiles.values()].map(value => structuredClone(value)) } },
    get(id) { const value = profiles.get(id); return value ? structuredClone(value) : undefined },
    has(id) { return profiles.has(id) },
    keys() { return profiles.keys() },
    values() { return [...profiles.values()].map(value => structuredClone(value)).values() },
  }
}
