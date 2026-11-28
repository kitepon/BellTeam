// send-gate.md: the first sendmessage from a sender to a Bot is refused, the next one for the same pair is delivered.
// shortcut: memory only, so a body restart arms every pair again; two parallel first calls to one pair let the second pass (the Owner's design has no token).
export const OWNER_SKILL = 'assign-owner'
export const OWNER_SKILL_PATH = '/srv/bellteam/shared/tools/assign-owner/SKILL.md'
export const OWNER_CHECK_CODE = 'SENDMESSAGE_OWNER_CHECK_REQUIRED'

// One line for the receiver of a Bot-sent direct message, between the preface and the body.
export const RECEIVER_LINE = `この依頼を受けるべきか、取りかかる前にスキル ${OWNER_SKILL}（${OWNER_SKILL_PATH}）で確かめてください。`

export function ownerCheckRefusal(bot) {
  const who = [bot.position, bot.role].filter(Boolean).join(' / ')
  const error = new Error(`${OWNER_CHECK_CODE}: まだ送っていません。宛先は「${bot.name}」（${who ? `${who}、` : ''}${bot.id}）です。送る前に、スキル ${OWNER_SKILL}（${OWNER_SKILL_PATH}）で、この依頼を渡す相手が正しいか判定してください。正しければ、同じ宛先でもう一度 sendmessage を呼ぶと送られます。違えば、正しい宛先で呼び直してください（その宛先も、最初の一回はこの確認になります）。`)
  error.code = OWNER_CHECK_CODE
  return error
}

// admit(from, bot) throws the refusal on the first call of a pair and arms it; on the next call it returns settle(), to run once the delivery is accepted.
export function createSendGate() {
  const armed = new Set()
  return {
    admit(from, bot) {
      const key = `${from}|${bot.id}`
      if (!armed.has(key)) { armed.add(key); throw ownerCheckRefusal(bot) }
      return () => armed.delete(key)
    },
  }
}

export const sendGate = createSendGate()
export const openSendGate = Object.freeze({ admit: () => () => {} })
