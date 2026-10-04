#!/usr/bin/env node
// ベルの席だけが自分のGrok設定（--scope project）へ登録するMCP。ユーザー規範の書き換えを持つ。
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { createGlobalInstructionsRefresher } from './global-instructions.mjs'
import { callOwnerTool, ownerTools } from './mcp-owner-tools.mjs'
import { OwnerProfile } from './owner-profile.mjs'
import { UserRules } from './user-rules.mjs'
import { runtimeHome } from './runtime-home.mjs'

const root = process.env.BELLTEAM_ROOT ?? '/srv/bellteam'
const ownerProfile = new OwnerProfile({ root })
await ownerProfile.initialize()
const userRules = new UserRules({ root })
await userRules.initialize()
const refreshGlobalInstructions = createGlobalInstructionsRefresher({ ownerProfile, userRules, home: runtimeHome() })

const server = new Server(
  { name: 'bellteam-owner', version: '0.1.0' },
  {
    capabilities: { tools: {} },
    instructions: 'オーナーの代行としてユーザー規範を書き換えるMCP。update_user_rulesへ全文を渡すと、画面と同じ正本を書き、全Botの起動時指示を作り直す。Botの再起動は不要で、次の配送から新しい規範が使われる。',
  },
)
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ownerTools }))
server.setRequestHandler(CallToolRequestSchema, async request => {
  const result = await callOwnerTool({ name: request.params.name, arguments: request.params.arguments, userRules, refreshGlobalInstructions })
  return { content: [{ type: 'text', text: JSON.stringify(result) }] }
})
await server.connect(new StdioServerTransport())
