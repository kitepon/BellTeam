// ベルの席だけが登録するMCP（bellteam-owner）のツール。誰が持つかは席ごとの登録で決まり、コードは役職やBot IDを判定しない。
export const ownerTools = Object.freeze([
  {
    name: 'update_user_rules',
    description: 'オーナーが全Botに課すユーザー規範の本文を全文置き換える。画面の保存と同じ正本を書く。部分編集ではなく全文を渡す。現在値の確認はbellteam MCPのget_user_rulesを使う。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', maxLength: 20000, description: 'ユーザー規範の全文' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
])

export async function callOwnerTool({ name, arguments: args = {}, userRules, refreshGlobalInstructions }) {
  const tool = ownerTools.find(item => item.name === name)
  if (!tool) throw new Error(`TOOL_NOT_FOUND: ${name}`)
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('TOOL_ARGUMENT_INVALID')
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(tool.inputSchema.properties, key)) throw new Error(`TOOL_ARGUMENT_INVALID: ${key}`)
  }
  if (name === 'update_user_rules') {
    const text = await userRules.update(args.text)
    await refreshGlobalInstructions()
    return { text }
  }
  throw new Error(`TOOL_NOT_FOUND: ${name}`)
}
