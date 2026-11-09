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
    async connect({ target, hostTrust, binding }) {
      if (typeof binding?.ref !== 'string' || !binding.ref) throw Object.assign(new Error('Unsupported credential'), { code: 'CREDENTIAL_UNUSABLE' })
      const { client, tool } = await start()
      try {
        const current = await tool('remote_terminal_status', { ref: binding.ref })
        if (current?.trust?.revision !== hostTrust.revision) throw Object.assign(new Error('Host trust revision changed'), { code: 'HOST_TRUST_STALE' })
        // Elegg: with `credential` (Mika handle) credentialRevision is omitted; without it, it is the native key revision.
        const key = binding.credential ? { credential: binding.credential } : { credentialRevision: binding.credentialRevision ?? current.credential?.revision }
        await tool('remote_terminal_open', { ref: binding.ref, target, trustRevision: hostTrust.revision, ...key, ...(binding.sudoCredential ? { sudoCredential: binding.sudoCredential } : {}) })
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

    // Elegg 0.67.0 credential-load: key bytes on stdin only (never argv); Aiterm keeps them in its per-terminal agent.
    async loadCredential({ ref, terminalId, handle, revision, purpose, key }) {
      if (typeof key !== 'string' || !key) throw Object.assign(new Error('Unsupported credential'), { code: 'CREDENTIAL_UNUSABLE' })
      await run('/usr/bin/env', [BIN, 'credential-load', '--ref', ref, '--terminal-id', terminalId, '--handle', handle, '--revision', String(revision), '--purpose', purpose], { input: key })
    },

    // Keyless binding for a terminal whose key comes from the secret card (Elegg: Aiterm-owned empty known_hosts.d/<ref>).
    async register({ host, user, port }) {
      const { stdout } = await run('/usr/bin/env', [BIN, 'register', '--host', host, '--user', user, '--port', String(port)])
      const ref = JSON.parse(String(stdout).trim())?.ref
      if (typeof ref !== 'string' || !ref) throw Object.assign(new Error('Remote terminal binding failed'), { code: 'REMOTE_AITERM_UNAVAILABLE' })
      return ref
    },

    // The Owner's "confirm the new host key": the UID1000 holder scans once and writes only if the fingerprint matches.
    async confirmHostKey(ref, fingerprint) {
      const { stdout, code } = await run('/usr/bin/env', [BIN, 'trust-confirm', '--ref', ref, '--fingerprint', fingerprint], { acceptNonzero: true, maxBuffer: 65536 })
      // Exit 2 = one JSON error line; keep only its code (mismatch vs unreachable), never raw text.
      if (code !== 0) {
        let dto = null
        try { dto = JSON.parse(String(stdout).trim().split('\n').pop()) } catch {}
        throw Object.assign(new Error('Host key not confirmed'), { code: typeof dto?.code === 'string' ? dto.code : 'REMOTE_AITERM_UNAVAILABLE' })
      }
      return (await status(ref))?.trust ?? null
    }
  }
}
