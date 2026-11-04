const uuidPattern = '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
const uuid = new RegExp(uuidPattern, 'u')
const values = {
  schema: { const: 'bellteam.automatic-configuration-application.v1' },
  requestId: { type: 'string', pattern: uuidPattern },
  state: { enum: ['pending', 'unknown', 'completed', 'failed', 'suppressed'] },
  phase: { enum: ['preparing', 'response', 'interrupt', 'turn_end', 'configure', 'resume'] },
  effect: { enum: ['not_started', 'possible', 'observed'] },
  laterEffect: { enum: ['unknown', 'excluded'] },
  stopIntent: { enum: ['not_requested', 'accepted', 'durable', 'unknown'] },
  admissionStopped: { type: 'boolean' },
  revocation: { enum: ['not_requested', 'pending', 'unknown', 'confirmed'] },
  errorCode: { enum: [null, 'AUTOMATIC_CONFIGURATION_UNKNOWN', 'AUTOMATIC_CONFIGURATION_UNAVAILABLE',
    'AUTOMATIC_CONFIGURATION_REVOKED', 'AUTOMATIC_CONFIGURATION_SUPERSEDED', 'AUTOMATIC_CONFIGURATION_INVALID'] },
}
for (const rule of Object.values(values)) { if (rule.enum) Object.freeze(rule.enum); Object.freeze(rule) }
const keys = Object.freeze(Object.keys(values))
export const automaticConfigurationApplicationSchema = Object.freeze({ type: 'object', additionalProperties: false,
  required: keys, properties: Object.freeze(values) })
export const configurationOperationError = (code, status) => Object.assign(new Error(code), { code, status })
export const validConfigurationOperationId = value => typeof value === 'string' && uuid.test(value)

export function automaticConfigurationApplication(value, expectedId) {
  try {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw null
    const fields = Object.getOwnPropertyDescriptors(value)
    if (Reflect.ownKeys(fields).length !== keys.length || !keys.every(key => Object.hasOwn(fields, key))) throw null
    const result = {}
    for (const key of keys) {
      if (!Object.hasOwn(fields[key], 'value')) throw null
      const item = fields[key].value, rule = values[key]
      if (Object.hasOwn(rule, 'const') && item !== rule.const || rule.enum && !rule.enum.includes(item)
        || rule.type && typeof item !== rule.type || rule.pattern && !validConfigurationOperationId(item)) throw null
      result[key] = item
    }
    if (expectedId !== undefined && result.requestId !== expectedId) throw null
    return Object.freeze(result)
  } catch {
    throw configurationOperationError('CONFIGURATION_OPERATION_READ_UNAVAILABLE', 503)
  }
}

export function automaticConfigurationView(operations, botId) {
  try {
    const operation = operations.get(botId)
    if (!operation) return null
    return automaticConfigurationApplication(operation.records.get(operation.currentRequestId), operation.currentRequestId)
  } catch {
    throw configurationOperationError('CONFIGURATION_OPERATION_READ_UNAVAILABLE', 503)
  }
}
