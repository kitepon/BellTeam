import assert from 'node:assert/strict'
import test from 'node:test'

import { callOwnerTool, ownerTools } from '../src/mcp-owner-tools.mjs'

test('bellteam-ownerのupdate_user_rulesは全文を書いて起動時指示を作り直す', async () => {
  const calls = []
  const userRules = { async update(text) { calls.push(['update', text]); return `${text}\n` } }
  const refreshGlobalInstructions = async () => { calls.push(['refresh']) }

  assert.deepEqual(await callOwnerTool({ name: 'update_user_rules', arguments: { text: '- 新しい規範' }, userRules, refreshGlobalInstructions }), { text: '- 新しい規範\n' })
  assert.deepEqual(calls, [['update', '- 新しい規範'], ['refresh']])
  await assert.rejects(callOwnerTool({ name: 'update_user_rules', arguments: { text: 'x', extra: 1 }, userRules, refreshGlobalInstructions }), /TOOL_ARGUMENT_INVALID: extra/u)
  await assert.rejects(callOwnerTool({ name: 'get_user_rules', userRules, refreshGlobalInstructions }), /TOOL_NOT_FOUND/u)
  assert.deepEqual(ownerTools.map(tool => tool.name), ['update_user_rules'])
  assert.deepEqual(ownerTools[0].inputSchema.required, ['text'])
})
