// Which item fields leave the module: variables named by label, and `credential` for a known executable.
// The run path (MCP) additionally follows the rules of the seat runner's secretEnv.
export const CREDENTIAL_VARIABLE = Object.freeze({ gh: 'GH_TOKEN' })
const SEND = /^[A-Z][A-Z0-9_]*$/u // file:VAR and ssh-key were designed, never shipped (README)
const RUN_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u
const RUN_REFUSED = /^(?:PATH|HOME|LD_.*|NODE_OPTIONS|BELLTEAM_.*)$/u

export function envReturn(fields, executable) {
  const env = Object.fromEntries(Object.entries(fields).filter(([label]) => SEND.test(label)))
  if (fields.credential && CREDENTIAL_VARIABLE[executable]) env[CREDENTIAL_VARIABLE[executable]] = fields.credential.trim()
  return env
}

// Returns null when the item cannot be handed to the runner (the call ends as "error", nothing starts).
export function runEnv(fields, executable) {
  const env = envReturn(fields, executable)
  const names = Object.keys(env)
  const bytes = names.reduce((n, k) => n + k.length + Buffer.byteLength(env[k]), 0)
  return names.length && names.length <= 32 && bytes <= 65536 && names.every(k => RUN_NAME.test(k) && !RUN_REFUSED.test(k)) ? env : null
}
