// The stop button sends the normal harness interruption through Aiterm (a532b2 stage 1: the older v2 proof reader is gone).

export function confirmedSessionClosure(result, session) {
  const receipt = result?.structuredContent
  return result?.isError !== true && receipt?.schema === 'aiterm.pty-close-result.v1'
    && Object.keys(receipt).length === 3 && receipt.session_id === session
    && ['closed', 'already_closed'].includes(receipt.outcome)
}

const failure = (code = 'EXECUTION_UNCONFIRMED', effect = 'possible') =>
  Object.assign(new Error(code), { code, effect, follow_up: 'status_only' })

// Stop-button path: Aiterm owns the harness-specific operation and traversal.
// This acknowledges sending that operation, not a proof of native completion.
export async function sendSessionStop(client, sessions, { pauseGoals = false } = {}) {
  const ids = [...new Set(sessions)]
  if (!ids.length) return { status: 'idle', targets: [] }
  const args = ids.length === 1 ? { session_id: ids[0] } : { session_ids: ids }
  // Only explicit whole-application stop pauses native goal continuation.
  // Ordinary conversation interruption keeps its existing wire contract.
  if (pauseGoals) args.pause_goals = true
  const result = await client.call('agent_stop', args, pauseGoals ? { meta: { 'aiterm/goal': { origin: 'user' } } } : {})
  const data = result?.structuredContent
  if (result?.isError || !data || !['sent', 'partial', 'failed', 'idle'].includes(data.status)
    || !Array.isArray(data.targets) || data.targets.some(target => !target || typeof target.session_id !== 'string'
      || !['sent', 'failed', 'idle'].includes(target.status))
    || ids.some(id => !data.targets.some(target => target.session_id === id))) throw failure()
  // A key receipt by itself (including an older response without goal_pause)
  // cannot confirm that an active goal stopped. Keep that receipt, and report
  // the affected roots as unconfirmed rather than inventing a pause result.
  if (pauseGoals && data.targets.some(target => !['paused', 'already_inactive', 'no_goal'].includes(target.goal_pause)))
    return { ...data, status: data.status === 'failed' ? 'failed' : 'partial' }
  return data
}

export function confirmedSessionInterruption(target) {
  return target?.session_preserved === 'confirmed'
    && ['interrupted', 'already_idle'].includes(target.interruption)
}
