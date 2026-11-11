// The fixed entry and run-seat-command have already loaded this target's env
// as UID1000. Only the MCP result crosses back; environment values stay here.
import { AitermClient, accountLoginEnvironment, runtimeLaunchEnv } from './aiterm-client.mjs'
import { authenticationPreflightFailure, launchRefusal } from './agent-launch-error.mjs'
import { mcpRequestContext } from './mcp-request-context.mjs'
import { returnedMcpError } from './returned-mcp-error.mjs'
import { isTerminalPath } from './terminals/paths.mjs'

let client, issued = false
try {
  if (process.getuid() !== 1000 || process.geteuid() !== 1000 || process.getgid() !== 1000)
    throw Error('SEAT_LAUNCH_IDENTITY')
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const request = JSON.parse(Buffer.concat(chunks).toString())
  // A terminal launch (one launch path) runs the CLI on the terminal: cwd is that folder and only named private env crosses.
  // cwd is the terminal's native absolute form (POSIX /... or Windows X:\...); terminals checks it against the real OS.
  const terminal = request.launch && Object.hasOwn(request.launch, 'terminal')
  let names = request.privateEnvNames
  const privateEnv = request.privateEnv ?? {}
  const name = key => typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)
  if (!request.launch || Object.hasOwn(request.launch, 'env_vars')
    || (terminal ? !['macos', 'windows'].some(os => isTerminalPath(os, request.launch.cwd))
      || !Array.isArray(names) || names.length < 1 || names.length > 16 || !names.every(name) || new Set(names).size !== names.length
      || !privateEnv || typeof privateEnv !== 'object' || Array.isArray(privateEnv)
      || !Object.entries(privateEnv).every(([key, value]) => names.includes(key) && key !== 'CLAUDE_CODE_OAUTH_TOKEN' && typeof value === 'string' && value.length > 0)
      : request.launch.cwd !== process.cwd() || Object.hasOwn(request, 'privateEnvNames') || Object.hasOwn(request, 'privateEnv')))
    throw Error('SEAT_LAUNCH_ARGUMENTS')
  // The launch's captured runtime must be in this MCP process's env before it starts (Aiterm reads its own process.env).
  if (request.runtime) Object.assign(process.env, runtimeLaunchEnv(request.runtime, process.env.PATH))
  // harness-accounts.md: a 2nd seat differs only in its login; read here as the seat user, given only to this CLI's env.
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  if (request.claudeLogin !== undefined) Object.assign(process.env, await accountLoginEnvironment(request.claudeLogin, process.env))
  // A legacy 1st (no token file yet) adds no login: the terminal keeps its own, so the name is not forwarded.
  if (terminal && process.env.CLAUDE_CODE_OAUTH_TOKEN === undefined) names = names.filter(key => key !== 'CLAUDE_CODE_OAUTH_TOKEN')
  // stdin only: never argv, disk or log. The login token still comes only from claudeLogin.
  Object.assign(process.env, privateEnv)
  if (terminal && !names.every(key => typeof process.env[key] === 'string' && process.env[key])) throw Error('SEAT_LAUNCH_ARGUMENTS')
  client = new AitermClient({ command: request.command, args: request.args, env: process.env, ...(request.runtime ? { runtimeCapture: request.runtime } : {}) })
  // Aiterm takes names and reads values from its own seat-owned MCP process. A terminal gets only the named ones, never server PATH/HOME.
  const env_vars = terminal ? [...names] : Object.keys(process.env).filter(key => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
  // Only this launcher's Aiterm reads it (account roots, harness-accounts.md E1); it is not forwarded to the seat.
  if (typeof request.claudeConfigRoots === 'string' && request.claudeConfigRoots) process.env.AITERM_CLAUDE_CONFIG_ROOTS = request.claudeConfigRoots
  let response
  try {
    issued = true
    response = { result: await client.call('agent_launch', { ...request.launch, env_vars }, { meta: request.meta }) }
  } catch (error) {
    const agentLaunchError = authenticationPreflightFailure(error.agentLaunchError)
    const refusal = launchRefusal(error.launchRefusal)
    const mcp_error = returnedMcpError(error)
    const mcp_request = mcpRequestContext(error)
    response = { error: { ...Object.fromEntries(['message', 'code', 'status', 'publicMessage',
      'aitermResponseReturned', 'executionError', 'launch', 'launchActionRequired', 'resumeUnavailable', 'effect'].filter(key => error[key] !== undefined).map(key => [key, error[key]])),
    ...(mcp_request ? { mcp_request } : {}), ...(agentLaunchError ? { agentLaunchError } : {}), ...(refusal ? { launchRefusal: refusal } : {}), ...(mcp_error ? { mcp_error } : {}) } }
  }
  await client.close()
  client = null
  process.stdout.write(JSON.stringify(response))
} catch (error) {
  // A refusal before agent_launch was issued keeps its own code (remote-seat.md step 5); anything else stays an exit failure.
  const code = /^SEAT_LAUNCH_[A-Z_]{1,40}$/u.test(error?.message) ? error.message : null
  if (!issued && code) process.stdout.write(JSON.stringify({ error: { message: code, code, effect: 'not_started' } }))
  else {
    process.stderr.write('BELLTEAM_SEAT_LAUNCH_FAILED\n')
    process.exitCode = 1
  }
} finally {
  await client?.close().catch(() => {})
}
