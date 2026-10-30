// Antigravity inherits launch env in stdio children but does not expand HTTP headers.
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SEAT_HEADER, SEAT_VARIABLE, LAUNCH_HEADER, LAUNCH_VARIABLE } from './seat-mcp.mjs'

async function main() {
  const seat = process.env[SEAT_VARIABLE]
  const launch = process.env[LAUNCH_VARIABLE]
  if (!seat || !/^[0-9a-f]{32}$/u.test(launch ?? '')) throw new Error('BELLTEAM_SEAT_UNRESOLVED')
  const upstream = new StreamableHTTPClientTransport(new URL(process.argv[2]), {
    requestInit: { headers: { [SEAT_HEADER]: seat, [LAUNCH_HEADER]: launch } },
    reconnectionOptions: { maxRetries: 0 },
  })
  const stdio = new StdioServerTransport()
  let closing = false
  let initializeId
  const close = async () => {
    if (closing) return
    closing = true
    await Promise.allSettled([upstream.close(), stdio.close()])
  }
  const fail = error => {
    if (closing) return
    process.exitCode = 1
    process.stderr.write(`BellTeam stdio: ${error.message}\n`)
    void close()
  }
  stdio.onmessage = message => {
    if (message.method === 'initialize') initializeId = message.id
    void upstream.send(message).catch(fail)
  }
  upstream.onmessage = message => {
    if (message.id === initializeId && message.result?.protocolVersion)
      upstream.setProtocolVersion(message.result.protocolVersion)
    void stdio.send(message).catch(fail)
  }
  stdio.onerror = upstream.onerror = fail
  stdio.onclose = upstream.onclose = close
  process.stdin.once('end', close)
  process.stdout.once('error', fail)
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
  await upstream.start()
  await stdio.start()
}

main().catch(error => {
  process.stderr.write(`BellTeam stdio: ${error.message}\n`)
  process.exitCode = 1
})
