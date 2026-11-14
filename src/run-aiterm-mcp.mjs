// Cursor leaves absent ${env:NAME} references unchanged. Remove only those
// references before starting the registered stdio MCP (or its lazy relay).
// Values belong to this CLI launch; never fill them from supervisor/job state.
import { spawn } from 'node:child_process'

const env = { ...process.env }
for (const name of ['AITERM_SESSION_ID', 'AITERM_AGENT_SESSION_ID', 'AITERM_AGENT_LAUNCH_ID', 'AITERM_AGENT_ROLE', 'AITERM_AGENT_DEPTH', 'AITERM_AGENT_LINEAGE', 'AITERM_AGENT_DELEGATION_ALLOWED', 'AITERM_STATE_BASE', 'BELLTEAM_RUNTIME_GENERATION', 'CODEX_BIN', 'CLAUDE_BIN', 'TMPDIR', 'XDG_RUNTIME_DIR', 'TEMP', 'TMP']) {
  if (env[name] === `\${env:${name}}`) delete env[name]
}

const [command, ...args] = process.argv.slice(2)
if (!command) {
  process.stderr.write('AITERM_MCP_START_FAILED\n')
  process.exitCode = 1
} else {
  let startFailed = false
  const child = spawn(command, args, { env, stdio: 'inherit' })
  const forwards = new Map(['SIGTERM', 'SIGINT', 'SIGHUP'].map(signal => {
    const forward = () => child.kill(signal)
    process.on(signal, forward)
    return [signal, forward]
  }))
  child.once('error', () => {
    startFailed = true
    process.stderr.write('AITERM_MCP_START_FAILED\n')
    process.exitCode = 1
  })
  child.once('close', (code, signal) => {
    for (const [name, forward] of forwards) process.removeListener(name, forward)
    if (startFailed) process.exitCode = 1
    else if (signal) process.kill(process.pid, signal)
    else process.exitCode = code ?? 1
  })
}
