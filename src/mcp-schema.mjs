export function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

export function assertKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('TOOL_ARGUMENT_INVALID')
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`TOOL_ARGUMENT_INVALID: ${key}`)
  }
}
