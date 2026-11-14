#!/usr/bin/env node
// Dedicated Owner MCP proxies to the parent; registration comments confer no authority.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { callOwnerTool, ownerTools } from './mcp-owner-tools.mjs'
import { createMembersOwnerProxy } from './members-owner-proxy.mjs'

const proxy = createMembersOwnerProxy({ port: Number(process.env.BELLTEAM_INTERNAL_PORT ?? 4181) })
const userRules = { update: text => proxy.updateUserRules(text) }

const server = new Server(
  { name: 'bellteam-owner', version: '0.1.0' },
  {
    capabilities: { tools: {} },
    instructions: 'オーナーの代行としてユーザー規範を書き換えるMCP。update_user_rulesへ全文を渡すと、画面と同じ正本を書き、全Botの起動時指示を作り直す。Botの再起動は不要で、次の配送から新しい規範が使われる。',
  },
)
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ownerTools }))
server.setRequestHandler(CallToolRequestSchema, async request => {
  const result = await callOwnerTool({ name: request.params.name, arguments: request.params.arguments, userRules })
  return { content: [{ type: 'text', text: JSON.stringify(result) }] }
})
await server.connect(new StdioServerTransport())
