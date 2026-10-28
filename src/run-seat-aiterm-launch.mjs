// The fixed entry and run-seat-command have already loaded this target's env
// as UID1000. Only the MCP result crosses back; environment values stay here.
import { AitermClient } from './aiterm-client.mjs'
import { authenticationPreflightFailure } from './agent-launch-error.mjs'
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
  client = new AitermClient({ command: request.command, args: request.args, env: process.env })
  // Aiterm takes names and reads values from its own seat-owned MCP process.
  const env_vars = Object.keys(process.env).filter(key => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
  let response
  try {
    response = { result: await client.call('agent_launch', { ...request.launch, env_vars }, { meta: request.meta }) }
  } catch (error) {
    const agentLaunchError = authenticationPreflightFailure(error.agentLaunchError)
    const mcp_error = returnedMcpError(error)
    response = { error: { ...Object.fromEntries(['message', 'code', 'status', 'publicMessage',
      'aitermResponseReturned', 'executionError', 'launch'].filter(key => error[key] !== undefined).map(key => [key, error[key]])),
    ...(agentLaunchError ? { agentLaunchError } : {}), ...(mcp_error ? { mcp_error } : {}) } }
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
