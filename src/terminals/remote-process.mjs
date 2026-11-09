// Elegg C3 (aiterm-mcp remote-terminal.md, f7022539): one UID1000 `aiterm-remote-terminal` stdio MCP process (`serve`) per
// reachability check or C8 run, started through the seat command entry like the parent's Aiterm. Process exit = closed.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { seatCommandSpec } from '../seat-command.mjs'
import { createSeatProcessRunner } from '../seat-process.mjs'

const BIN = 'aiterm-remote-terminal'

async function stdioClient(project) {
  const client = new Client({ name: 'bellteam-terminals', version: '0.1.0' }, { capabilities: {} })
  await client.connect(new StdioClientTransport({ ...seatCommandSpec('/usr/bin/env', [BIN, 'serve'], { project }), stderr: 'ignore' }))
  return client
}

// Tool errors arrive as {code, message, action?} JSON; keep only those fields (no raw stderr).
function parse(result) {
  let value = result?.structuredContent
  if (value === undefined) { try { value = JSON.parse(result?.content?.[0]?.text ?? 'null') } catch { value = null } }
  if (result?.isError) throw Object.assign(new Error(typeof value?.message === 'string' ? value.message : 'Remote terminal failed'), { code: value?.code ?? 'REMOTE_AITERM_UNAVAILABLE', ...(typeof value?.action === 'string' ? { action: value.action } : {}) })
  return value
}

export function createRemoteTerminalProcesses({ project, connectClient = () => stdioClient(project), run = createSeatProcessRunner(project) } = {}) {
  async function start() {
    let client
    try { client = await connectClient() } catch { throw Object.assign(new Error('Remote terminal process unavailable'), { code: 'REMOTE_AITERM_UNAVAILABLE' }) }
    const tool = async (name, args = {}) => parse(await client.callTool({ name, arguments: args }))
    return { client, tool }
  }

  async function status(ref) {
    const { client, tool } = await start()
    try { return await tool('remote_terminal_status', { ref }) } finally { await client.close().catch(() => {}) }
  }

  return {
    async trust(ref) { return (await status(ref))?.trust ?? null },

    // Transient process for reachability and C8 only; seats run through Aiterm's own agent_launch (Trony ruling 2026-11-09).
    async connect({ target, hostTrust, credential }) {
      if (!credential?.nativeKeyRef) throw Object.assign(new Error('Unsupported credential'), { code: 'CREDENTIAL_UNUSABLE' })
      const { client, tool } = await start()
      try {
        const current = await tool('remote_terminal_status', { ref: credential.nativeKeyRef })
        if (current?.trust?.revision !== hostTrust.revision) throw Object.assign(new Error('Host trust revision changed'), { code: 'HOST_TRUST_STALE' })
        await tool('remote_terminal_open', { ref: credential.nativeKeyRef, target, trustRevision: hostTrust.revision, credentialRevision: credential.credentialRevision ?? current.credential?.revision })
      } catch (error) { await client.close().catch(() => {}); throw error }
      return {
        command: op => tool('remote_terminal_command', { op }),
        async close() {
          await tool('remote_terminal_close').catch(() => {})
          await client.close().catch(() => {})
          return { closed: true }
        }
      }
    },

    // The Owner's "confirm the new host key": the UID1000 holder scans once and writes only if the fingerprint matches.
    async confirmHostKey(ref, fingerprint) {
      await run('/usr/bin/env', [BIN, 'trust-confirm', '--ref', ref, '--fingerprint', fingerprint])
      return (await status(ref))?.trust ?? null
    }
  }
}
