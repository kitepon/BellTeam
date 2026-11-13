import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { objectSchema } from './mcp-schema.mjs'
const object = properties => objectSchema(properties, Object.keys(properties))
const date = { type: 'string', format: 'date-time' }
const nil = { type: 'null' }
// No upper bound (Owner 2026-11-09: a summary is never discarded for its length); non-empty, trimmed, one line.
const summary = { type: 'string', minLength: 1, pattern: '^(?!\\s)(?!.*\\s$)[^\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+$' }
// Optional 7th key (a41, 2026-11-13): why a working Bot counts as working. Absent or null = unknown (older engine).
// detail is a masked descriptor ("<exe> <args>"), never a raw command line.
const reason = { anyOf: [nil, object({ kind: { enum: ['turn', 'schedule', 'background', 'subagent'] }, detail: { anyOf: [summary, nil] }, since: { anyOf: [date, nil] } })] }
const keys = ['state', 'summary', 'summaryStatus', 'summaryUpdatedAt', 'observedAt', 'source']
export const currentWorkSchema = { oneOf: ['working', 'idle', 'unknown'].flatMap(state => ['current', 'missing', 'stale'].map(status => objectSchema({
  state: { const: state }, summary: status === 'current' ? summary : nil, summaryStatus: { const: status },
  summaryUpdatedAt: status === 'missing' ? nil : date, observedAt: state === 'unknown' ? { anyOf: [date, nil] } : date,
  source: status === 'missing' ? nil : state === 'working' ? { enum: ['self_reported', 'background_agent'] } : { const: 'background_agent' },
  reason: state === 'working' ? reason : nil,
}, keys))) }
export const currentWorkBindingSchema = object({ sessionId: { type: 'string', minLength: 1 }, launchId: { type: 'string', minLength: 1 }, turnId: { type: 'string', minLength: 1 }, revision: { type: 'string', format: 'uuid' } })
// The execution writer trims; the length is not limited.
export const updateWorkSummaryInputSchema = object({ expected: currentWorkBindingSchema,
  summary: { anyOf: [{ type: 'string', description: '前後の空白を除き1文字以上。長さの上限なし（目安はメンバーカード2行、全角40字）。改行・制御文字は不可。' }, nil] } })
export const roomCurrentWorkSchema = object({ scope: { const: 'participants' }, members: { type: 'array', items: object({ botId: { type: 'string', minLength: 1 }, currentWork: currentWorkSchema }) } })
const validator = new AjvJsonSchemaValidator()
export const validateCurrentWork = validator.getValidator(currentWorkSchema)
const binding = validator.getValidator(currentWorkBindingSchema)
export const unknownCurrentWork = () => ({ state: 'unknown', summary: null, summaryStatus: 'missing', summaryUpdatedAt: null, observedAt: null, source: null })
export function readCurrentWork(transport, bot) {
  if (!bot) return unknownCurrentWork()
  try { const value = transport?.currentWork?.(bot); return validateCurrentWork(value).valid ? structuredClone(value) : unknownCurrentWork() }
  catch { return unknownCurrentWork() }
}
export function readCurrentWorkBinding(read, bot) {
  try { const value = read?.(bot); return binding(value).valid ? structuredClone(value) : null }
  catch { return null }
}
export const currentWorkErrors = Object.freeze({ CURRENT_WORK_INPUT_INVALID: 400, CURRENT_WORK_FORBIDDEN: 403, CURRENT_WORK_CONFLICT: 409, CURRENT_WORK_UNAVAILABLE: 503 })
