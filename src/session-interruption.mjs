// Session-preserving stop v2 only. No close fallback, key retry or inference
// from an accepted key, absent session, idle display, or queue removal.
import { isDeepStrictEqual as same } from 'node:util'

const failure = (code = 'EXECUTION_UNCONFIRMED', effect = 'possible') =>
  Object.assign(new Error(code), { code, effect, follow_up: 'status_only' })
const launch = value => value && typeof value.session_id === 'string'
  && /^[A-Za-z0-9_-]{1,64}$/u.test(value.session_id)
  && typeof value.launch_id === 'string' && /^[0-9a-f]{32}$/u.test(value.launch_id)
const boundary = value => value && Number.isSafeInteger(value.event_cursor) && value.event_cursor >= 0
  && (value.operation_id === null || typeof value.operation_id === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value.operation_id))
  && (value.turn_id === null || typeof value.turn_id === 'string' && value.turn_id.length > 0)
  && (value.steer_id === null || typeof value.steer_id === 'string' && /^[0-9a-f]{16}$/u.test(value.steer_id))
const point = value => value && launch(value.launch) && (value.boundary === null || boundary(value.boundary))

export function confirmedSessionInterruption(target) {
  return target?.session_preserved === 'confirmed'
    && ['interrupted', 'already_idle'].includes(target.interruption)
}

export async function requestSessionInterruption(call, roots) {
  if (!Array.isArray(roots) || roots.length === 0 || !roots.every(launch))
    throw failure('EXECUTION_INVALID', 'not_started')
  const expected = structuredClone(roots)
  const result = await call({ schema: 'aiterm.cascade-stop-request.v2', mode: 'interrupt', roots: structuredClone(expected) })
  const data = result?.structuredContent
  if (result?.isError || result?._meta?.['aiterm/execution_error']
    || data?.schema !== 'aiterm.cascade-stop-result.v2' || data.mode !== 'interrupt'
    || !same(data.roots, expected) || !['confirmed', 'partial', 'unconfirmed'].includes(data.status)
    || !['complete', 'incomplete'].includes(data.relation_coverage)
    || !Array.isArray(data.unresolved) || !data.unresolved.every(item => item && typeof item.reason === 'string')
    || !Array.isArray(data.targets) || !data.targets.every(target => target && launch(target.launch)
      && (target.run === null || point(target.run) && same(target.run.launch, target.launch))
      && [null, 'Escape', 'C-c'].includes(target.key)
      && ['not_sent', 'accepted', 'unknown'].includes(target.key_receipt)
      && ['interrupted', 'already_idle', 'unconfirmed', 'unsupported', 'replaced'].includes(target.interruption)
      && ['confirmed', 'unconfirmed'].includes(target.session_preserved) && typeof target.reason === 'string'
      && !(target.key_receipt === 'accepted' && target.key === null)
      && !(target.interruption === 'interrupted' && target.run?.boundary == null)
      && !(target.interruption === 'already_idle' && (target.key !== null || target.key_receipt !== 'not_sent')))
    || expected.some(root => !data.targets.some(target => same(target.launch, root)))) throw failure()
  if (data.status === 'confirmed' && (data.relation_coverage !== 'complete' || data.unresolved.length
    || !data.targets.every(confirmedSessionInterruption))) throw failure()
  if (data.status === 'partial' && !data.targets.some(confirmedSessionInterruption)) throw failure()
  // Preserve partial/unsupported and local-idle results. No branch finish or
  // permanent launch fence is synthesized by this wire reader.
  return data
}
