// 認証と起動前診断は、既存の型付きreceiptだけを残し秘密を含み得る本文を記録しない。
const privateTools = new Set(['agent_auth', 'agent_launch', 'claude_agent'])
const reportableTool = tool => typeof tool === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(tool) && !privateTools.has(tool)
const privateField = /(?:text|prompt|message|input|response|answer|value|code|objective|token|password|secret|key|authorization)$/iu

export function captureMcpError(tool, message, args) {
  if (!reportableTool(tool)) return null
  const inputs = []
  const collect = (value, privateValue = false) => {
    if (typeof value === 'string' && privateValue && value) inputs.push(value)
    else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) collect(entry, privateValue || privateField.test(key))
  }
  collect(args)
  const representations = inputs.flatMap(input => [input, JSON.stringify(input).slice(1, -1)])
  for (const input of representations.sort((a, b) => b.length - a.length)) message = message.replaceAll(input, '[input omitted]')
  message = message.replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, '$1 [secret omitted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/gu, '[secret omitted]')
    .replace(/\b([A-Za-z0-9_-]*(?:token|password|secret|api[_-]?key|authorization))["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;"'}]+)/giu, '$1=[secret omitted]')
    .replace(/\b(https?:\/\/)[^/\s@]+@/giu, '$1[secret omitted]@')
  return { tool, message: message.slice(0, 4096), truncated: message.length > 4096 }
}

export function returnedMcpError(error) {
  const value = error?.mcp_error ?? error?.cause?.mcp_error
  return value && reportableTool(value.tool) && typeof value.message === 'string' && value.message.length <= 4096
    && typeof value.truncated === 'boolean'
    ? { tool: value.tool, message: value.message, truncated: value.truncated } : null
}
