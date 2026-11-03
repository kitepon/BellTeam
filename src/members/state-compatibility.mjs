import { isDeepStrictEqual } from 'node:util'

// Existing on-disk formats; this declaration does not authorize migration.
export const MEMBERS_STATE_COMPATIBILITY = Object.freeze({
  botProfileSchema: 'bellteam.bot.v8',
  scheduleSchema: 'bellteam.schedule.v1',
  ownerProfileSchema: 'bellteam.owner-profile.v1',
  deletionReceiptSchema: 'bellteam.bot-deletion.v1',
  userRulesEncoding: 'utf8',
  initializedMarker: '.initialized',
})

export function assertMembersStateCompatibility(value) {
  if (!isDeepStrictEqual(value, MEMBERS_STATE_COMPATIBILITY))
    throw Object.assign(new Error('MEMBERS_STATE_INCOMPATIBLE'), { code: 'MEMBERS_STATE_INCOMPATIBLE' })
}
