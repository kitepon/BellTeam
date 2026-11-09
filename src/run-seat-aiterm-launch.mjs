// The fixed entry and run-seat-command have already loaded this target's env
// as UID1000. Only the MCP result crosses back; environment values stay here.
import { AitermClient, accountLoginEnvironment, runtimeLaunchEnv } from './aiterm-client.mjs'
import { authenticationPreflightFailure } from './agent-launch-error.mjs'
import { mcpRequestContext } from './mcp-request-context.mjs'
import { returnedMcpError } from './returned-mcp-error.mjs'

let client
try {
  if (process.getuid() !== 1000 || process.geteuid() !== 1000 || process.getgid() !== 1000)
    throw Error('SEAT_LAUNCH_IDENTITY')
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const request = JSON.parse(Buffer.concat(chunks).toString())
  if (request.launch?.cwd !== process.cwd() || Object.hasOwn(request.launch, 'env_vars'))
    throw Error('SEAT_LAUNCH_ARGUMENTS')
  // The launch's captured runtime must be in this MCP process's env before it starts (Aiterm reads its own process.env).
  if (request.runtime) Object.assign(process.env, runtimeLaunchEnv(request.runtime, process.env.PATH))
  // harness-accounts.md: a 2nd seat differs only in its login; read here as the seat user, given only to this CLI's env.
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  if (request.claudeLogin !== undefined) Object.assign(process.env, await accountLoginEnvironment(request.claudeLogin, process.env))
  client = new AitermClient({ command: request.command, args: request.args, env: process.env, ...(request.runtime ? { runtimeCapture: request.runtime } : {}) })
  // Aiterm takes names and reads values from its own seat-owned MCP process.
  const env_vars = Object.keys(process.env).filter(key => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
  // Only this launcher's Aiterm reads it (account roots, harness-accounts.md E1); it is not forwarded to the seat.
  if (typeof request.claudeConfigRoots === 'string' && request.claudeConfigRoots) process.env.AITERM_CLAUDE_CONFIG_ROOTS = request.claudeConfigRoots
  let response
  try {
    response = { result: await client.call('agent_launch', { ...request.launch, env_vars }, { meta: request.meta }) }
  } catch (error) {
    const agentLaunchError = authenticationPreflightFailure(error.agentLaunchError)
    const mcp_error = returnedMcpError(error)
    const mcp_request = mcpRequestContext(error)
    response = { error: { ...Object.fromEntries(['message', 'code', 'status', 'publicMessage',
      'aitermResponseReturned', 'executionError', 'launch', 'launchActionRequired', 'resumeUnavailable', 'effect'].filter(key => error[key] !== undefined).map(key => [key, error[key]])),
    ...(mcp_request ? { mcp_request } : {}), ...(agentLaunchError ? { agentLaunchError } : {}), ...(mcp_error ? { mcp_error } : {}) } }
  }
  await client.close()
  client = null
  process.stdout.write(JSON.stringify(response))
} catch {
  process.stderr.write('BELLTEAM_SEAT_LAUNCH_FAILED\n')
  process.exitCode = 1
} finally {
  await client?.close().catch(() => {})
}
