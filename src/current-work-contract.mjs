import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { objectSchema } from './mcp-schema.mjs'
const object = properties => objectSchema(properties, Object.keys(properties))
const date = { type: 'string', format: 'date-time' }
const nil = { type: 'null' }
const summary = { type: 'string', minLength: 1, maxLength: 160, pattern: '^(?!\\s)(?!.*\\s$)[^\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+$' }
export const currentWorkSchema = { oneOf: [['working', 'current'], ['working', 'missing'], ['working', 'stale'], ['idle', 'missing'], ['unknown', 'missing']].map(([state, status]) => object({
  state: { const: state }, summary: status === 'current' ? summary : nil, summaryStatus: { const: status },
  summaryUpdatedAt: status === 'missing' ? nil : date, observedAt: state === 'unknown' ? { anyOf: [date, nil] } : date,
  source: status === 'missing' ? nil : { const: 'self_reported' },
})) }
export const currentWorkBindingSchema = object({ sessionId: { type: 'string', minLength: 1 }, launchId: { type: 'string', minLength: 1 }, turnId: { type: 'string', minLength: 1 }, revision: { type: 'string', format: 'uuid' } })
// The execution writer trims before enforcing the 160-code-point limit.
export const updateWorkSummaryInputSchema = object({ expected: currentWorkBindingSchema,
  summary: { anyOf: [{ type: 'string', description: '前後の空白を除き1〜160 Unicode文字。改行・制御文字は不可。' }, nil] } })
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
