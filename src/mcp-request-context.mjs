// Only canonical tools used by BellTeam cross the diagnostics boundary.
const tools = new Set(['pty_list', 'pty_read', 'pty_observe', 'pty_send', 'pty_close',
  'agent_launch', 'claude_agent', 'agent_models', 'agent_configure', 'agent_goal',
  'agent_auth', 'agent_stop', 'agent_execution', 'agent_execution_roots'])
const contexts = new WeakMap()

function validate(value) {
  if (!value || typeof value !== 'object') return null
  const { phase, tool } = value
  if (!tools.has(tool)) return null
  if (phase === 'connect' && Reflect.ownKeys(value).sort().join(',') === 'phase,tool')
    return { phase, tool }
  if (phase === 'call' && value.outcome === 'unknown'
    && Reflect.ownKeys(value).sort().join(',') === 'outcome,phase,tool')
    return { phase, tool, outcome: 'unknown' }
  return null
}

export function mcpRequestContext(error) {
  try { return validate(contexts.get(error) ?? error?.mcp_request) } catch { return null }
}

export function captureMcpRequest(error, phase, tool) {
  const value = validate({ phase, tool, ...(phase === 'call' ? { outcome: 'unknown' } : {}) })
  if (!value || !error || !['object', 'function'].includes(typeof error)) return
  // Frozen SDK errors must retain provenance without replacing the original exception.
  contexts.set(error, value)
  try { error.mcp_request = { ...value } } catch {}
}
