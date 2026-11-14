import { readCurrentWork, readCurrentWorkBinding } from './current-work-contract.mjs'
import { usageTools, usageToolHandlers } from './usage/mcp-tools.mjs'
import { bugHubSecurityTools } from './bughub-security.mjs'
import { objectSchema, assertKeys } from './mcp-schema.mjs'
import { conversationTools, callConversationTool } from './mcp-conversation-tools.mjs'
import { botScheduleTools, roomScheduleTools, scheduleToolHandlers } from './members/schedules-mcp.mjs'
import { memberReadTools, memberWriteTools, callMemberTool } from './members/profiles-mcp.mjs'

export { resolveBotImagePath } from './bot-image-path.mjs'
import { deleteBotTool, runDeleteBotTool } from './members/deletion.mjs'
import { terminalTools, callTerminalTool } from './terminals-mcp.mjs'
import { latticeTools, latticeToolHandlers } from './lattice/mcp.mjs'
import { runningExclusionTools, callRunningExclusionTool } from './running-exclusions-mcp.mjs'

export const bellTeamTools = Object.freeze([
  {
    name: 'list_models',
    description: 'BellTeam内蔵のCLIが今返すモデルとエフォートをAitermから取得する。harness省略時は4種すべて。取得に失敗したCLIはerrorに理由を返す。AIのターンは起こさない。',
    inputSchema: objectSchema({ harness: { type: 'string', enum: ['claude', 'codex', 'grok', 'cursor', 'antigravity'] } }),
    annotations: { readOnlyHint: true },
  },
  ...usageTools(objectSchema),
  ...memberReadTools,
  {
    name: 'remember',
    description: '会話から残すべき事実、好み、方針、仕事、関係、思い出、成長を長期記憶へ保存する。scope省略時は自分だけのpersonal。sharedは全Botで共有される。',
    inputSchema: objectSchema({
      content: { type: 'string', minLength: 1, description: '記憶する内容' },
      kind: { type: 'string', enum: ['fact', 'preference', 'policy', 'task', 'config', 'incident', 'relationship', 'episode', 'growth'] },
      scope: { type: 'string', enum: ['personal', 'shared'] },
      importance: { type: 'integer', minimum: 1, maximum: 10 },
    }, ['content']),
  },
  {
    name: 'recall_memory',
    description: '長期記憶を検索する。scope省略時は自分だけのpersonalで、共通記憶はsharedを明示した時だけ検索する。',
    inputSchema: objectSchema({
      query: { type: 'string', minLength: 1 },
      scope: { type: 'string', enum: ['personal', 'shared'] },
    }, ['query']),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'revise_memory',
    description: '自分の既存記憶を新しい内容へ更新し、古い記憶を履歴として残す。',
    inputSchema: objectSchema({
      id: { type: 'string', minLength: 1 },
      content: { type: 'string', minLength: 1 },
      kind: { type: 'string', enum: ['fact', 'preference', 'policy', 'task', 'config', 'incident', 'relationship', 'episode', 'growth'] },
      scope: { type: 'string', enum: ['personal', 'shared'] },
      importance: { type: 'integer', minimum: 1, maximum: 10 },
    }, ['id', 'content']),
  },
  {
    name: 'pin_memory',
    description: '人格形成に残す重要な思い出を、長期記憶内で固定または解除する。',
    inputSchema: objectSchema({
      id: { type: 'string', minLength: 1 },
      pinned: { type: 'boolean' },
      scope: { type: 'string', enum: ['personal', 'shared'] },
    }, ['id']),
  },
  {
    name: 'consolidate_growth',
    description: '複数の過去の思い出を、AIが作った一つの成長記憶へ統合する。固定済みの思い出は残す。',
    inputSchema: objectSchema({
      memoryIds: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
      content: { type: 'string', minLength: 1 },
      scope: { type: 'string', enum: ['personal', 'shared'] },
      importance: { type: 'integer', minimum: 1, maximum: 10 },
    }, ['memoryIds', 'content']),
  },
  {
    name: 'record_knowledge',
    description: '再利用する調査、仕様、手順、設計知識をMarkdown置き場と検索索引へ同時登録する。scope省略時はpersonal。sharedは全Botで共有される。',
    inputSchema: objectSchema({
      title: { type: 'string', minLength: 1 },
      content: { type: 'string', minLength: 1 },
      source: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'string' },
      scope: { type: 'string', enum: ['personal', 'shared'] },
    }, ['title', 'content']),
  },
  {
    name: 'search_knowledge',
    description: '個人またはBellTeam共通のナレッジ（RAG）と長期記憶を検索する。scope省略時はpersonalで、共通はsharedを明示した時だけ検索する。',
    inputSchema: objectSchema({
      query: { type: 'string', minLength: 1 },
      scope: { type: 'string', enum: ['personal', 'shared'] },
    }, ['query']),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'restart_session',
    description: 'BotのAIセッションを終了し、現在のCLI設定とMCP設定を読み直して起動する。新しいセッションの起動まで待って結果を返し、できなかった時は理由を返す（前のセッションを閉じられなかった時は起動しない）。botId省略時は自分。',
    inputSchema: objectSchema({ botId: { type: 'string', minLength: 1 } }),
  },
  {
    name: 'set_fast_mode',
    description: 'BotのCLIのファストモード（応答を速くする設定。利用枠を多く使い、Claudeでは別払いになる）を切り替える。botId省略時は自分。稼働中なら現在の作業の後に適用する。CLIやモデルが対応していない時と、そのCLIのアカウントで使えない時（Claudeは別払いが有効な時だけ使える）は、保存せずに理由を返して断る。適用できなかった時は元の値へ戻す。今の値はget_selfのfastModeで確かめる。',
    inputSchema: objectSchema({
      enabled: { type: 'boolean', description: 'trueで有効、falseで無効（通常の速度）。' },
      botId: { type: 'string', minLength: 1 },
    }, ['enabled']),
  },
  deleteBotTool,
  ...memberWriteTools,
  ...botScheduleTools,
  ...conversationTools,
  ...roomScheduleTools,
  ...bugHubSecurityTools,
  ...terminalTools,
  ...latticeTools,
  ...runningExclusionTools,
])

// Owner 2026-11-10: a fork seat never writes inside any Bot project folder (/srv/bellteam/bots/*/), SQL stores included.
// These tools always do (AGENTS.md/CLAUDE.md rewrite, docs, previous-session.md, project create/remove);
// the store writers only in scope personal. Everything else stays open to a fork.
// use_secret runs a command in the Bot's project.
const PROJECT_WRITERS = new Set(['use_secret', 'write_member_doc', 'update_self', 'update_bot', 'set_avatar', 'set_fast_mode', 'restart_session', 'create_bot', 'delete_bot'])
const PERSONAL_STORE_WRITERS = new Set(['remember', 'revise_memory', 'pin_memory', 'consolidate_growth', 'record_knowledge'])
export const forkWritesProject = (name, args = {}) =>
  PROJECT_WRITERS.has(name) || (PERSONAL_STORE_WRITERS.has(name) && args?.scope !== 'shared')

// 長期記憶の1件は1つの話にする（2026-10-14 オーナー裁定）。直すたびに前の版へ足して伸びるので、長い物は拒まずに、返りで分ける様に知らせる。
const MEMORY_SPLIT_NOTICE_CHARS = 2000

function withMemoryLengthNotice(memory, content) {
  const length = typeof content === 'string' ? content.trim().length : 0
  if (length <= MEMORY_SPLIT_NOTICE_CHARS) return { memory }
  return {
    memory,
    notice: `この記憶は${length}字ある。1件は1つの話にして、${MEMORY_SPLIT_NOTICE_CHARS}字を超える時は分ける。手順・仕様・調べた結果はrecord_knowledgeへ置き、記憶には出来事と結末を残す。`,
  }
}

// 画像本体（data URL）は1枚で十万文字を超え、CLIの道具の上限を超える。返事では本体を外し、有無と取得先だけを返す。
function withoutAvatarBody(value, avatarUrl) {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'avatar')) return value
  const { avatar, avatarLarge, avatarSource, avatarLargeSource, ...rest } = value
  const hasAvatar = typeof avatar === 'string' && avatar !== ''
  return { ...rest, hasAvatar, ...(hasAvatar && avatarUrl ? { avatarUrl } : {}) }
}

export async function callBellTeamTool({ internalUrl = '', ...context }) {
  const result = await runBellTeamTool(context)
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const shaped = { ...result }
  if (shaped.bot) shaped.bot = withoutAvatarBody(shaped.bot, internalUrl && `${internalUrl}/api/bots/${shaped.bot.id}/avatar`)
  if (shaped.owner) shaped.owner = withoutAvatarBody(shaped.owner, internalUrl && `${internalUrl}/api/owner/avatar`)
  if (shaped.room) shaped.room = withoutAvatarBody(shaped.room)
  if (Array.isArray(shaped.rooms)) shaped.rooms = shaped.rooms.map(room => withoutAvatarBody(room))
  return shaped
}

async function runBellTeamTool(context) {
  const { name, arguments: args = {}, from, registry, botView = bot => bot, bugHubSecurity, messenger, store, rooms, roomMessenger, memory, ownerProfile, userRules, deliverMessage, deliverForkInquiry, deliverRoomMessage, listQueued, restart, remove, configure, getModels } = context
  const tool = bellTeamTools.find(item => item.name === name)
  if (!tool) throw new Error(`TOOL_NOT_FOUND: ${name}`)
  assertKeys(args, Object.keys(tool.inputSchema.properties))
  await registry.refresh()
  if (!registry.get(from)) throw new Error(`BOT_NOT_FOUND: ${from}`)
  if (!['sendmessage', 'send_user_message'].includes(name)) await rooms?.refresh?.()

  if (name.startsWith('bughub_')) {
    if (!bugHubSecurity) throw new Error('BUGHUB_SECURITY_NOT_CONFIGURED')
    return bugHubSecurity({ name, args, from })
  }
  if (name === 'get_self') {
    const result = await callMemberTool({ name, args, from, registry, botView, configure, memory, ownerProfile, userRules })
    const bot = requireBot(registry, from)
    return { ...result, bot: { ...result.bot, currentWork: readCurrentWork(context, bot), currentWorkBinding: readCurrentWorkBinding(context.currentWorkBinding, bot) } }
  }
  if (name === 'list_models') return getModels(args.harness)
  if (runningExclusionTools.some(tool => tool.name === name)) return callRunningExclusionTool({ name, args, from, registry, runningExclusions: context.runningExclusions?.() })
  if (terminalTools.some(tool => tool.name === name)) return callTerminalTool({ name, args, terminals: context.terminals, terminalKeys: context.terminalKeys })
  if ([...memberReadTools, ...memberWriteTools].some(tool => tool.name === name))
    return callMemberTool({ name, args, from, registry, botView, configure, memory, ownerProfile, userRules, store,
      deliverMessage: deliverMessage ?? (value => messenger.sendmessage(value)) })
  if (Object.hasOwn(scheduleToolHandlers, name)) return scheduleToolHandlers[name]({ registry, rooms, from, args })
  if (Object.hasOwn(usageToolHandlers, name)) return usageToolHandlers[name]({ ...context, args })
  if (Object.hasOwn(latticeToolHandlers, name)) {
    if (!context.lattice) throw Object.assign(new Error('LATTICE_UNAVAILABLE'), { code: 'LATTICE_UNAVAILABLE', status: 503 })
    // from is the seat resolved by seat-mcp (a fork resolves to its parent Bot), never a tool argument.
    return latticeToolHandlers[name]({ lattice: context.lattice, from, args })
  }
  if (conversationTools.some(tool => tool.name === name))
    return callConversationTool({ name, args, from, registry, messenger, store, rooms, roomMessenger, deliverMessage, deliverForkInquiry, deliverRoomMessage, listQueued })
  if (name === 'remember') return withMemoryLengthNotice(await memory.remember({ botId: from, ...args, sourceRef: 'mcp' }), args.content)
  if (name === 'recall_memory') return memory.recallMemory({ botId: from, ...args, ...(context.fork ? { readOnly: true } : {}) })
  if (name === 'revise_memory') return withMemoryLengthNotice(await memory.reviseMemory({ botId: from, ...args }), args.content)
  if (name === 'pin_memory') return { memory: await memory.pinMemory({ botId: from, ...args }) }
  if (name === 'consolidate_growth') return { memory: await memory.consolidateGrowth({ botId: from, ...args }) }
  if (name === 'record_knowledge') return { knowledge: await memory.recordKnowledge({ botId: from, ...args }) }
  if (name === 'search_knowledge') return memory.searchKnowledge({ botId: from, ...args, ...(context.fork ? { readOnly: true } : {}) })
  if (name === 'restart_session') {
    const botId = args.botId ?? from
    requireBot(registry, botId)
    return restart(botId)
  }
  if (name === 'set_fast_mode') {
    const botId = args.botId ?? from
    requireBot(registry, botId)
    // 稼働中セッションへの適用が要るので、モデル・エフォートと同じく設定画面と同じ経路（supervisor）で保存と適用を行う。
    return configure(botId, { fastMode: args.enabled })
  }
  if (name === 'delete_bot') return runDeleteBotTool({ registry, from, arguments: args, remove })
  throw new Error(`TOOL_NOT_FOUND: ${name}`)
}

function requireBot(registry, id) {
  const bot = registry.get(id)
  if (!bot) throw new Error(`BOT_NOT_FOUND: ${id}`)
  return bot
}
