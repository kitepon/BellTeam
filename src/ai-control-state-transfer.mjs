function failure(code) { return Object.assign(new Error(code), { code }) }

export function validateAiControlState(bytes) {
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw failure('AI_CONTROL_TRANSFER_INVALID') }
  if (value?.schema !== 'bellteam.ai-control.v1' || typeof value.paused !== 'boolean'
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
    || !(value.resumedAt == null || typeof value.resumedAt === 'string' && Number.isFinite(Date.parse(value.resumedAt)))) {
    throw failure('AI_CONTROL_TRANSFER_INVALID')
  }
}
