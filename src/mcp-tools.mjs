import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { usageTools, usageToolHandlers } from './usage/mcp-tools.mjs'
import { bugHubSecurityTools } from './bughub-security.mjs'
import { objectSchema, assertKeys } from './mcp-schema.mjs'
import { conversationTools, callConversationTool } from './mcp-conversation-tools.mjs'
import { botScheduleTools, roomScheduleTools, scheduleToolHandlers } from './members/schedules-mcp.mjs'
import { resolveBotImagePath } from './bot-image-path.mjs'

export { resolveBotImagePath } from './bot-image-path.mjs'
import { deleteBotTool, runDeleteBotTool } from './members/deletion.mjs'

export const bellTeamTools = Object.freeze([
  {
    name: 'list_models',
    description: 'BellTeam内蔵のCLIが今返すモデルとエフォートをAitermから取得する。harness省略時は4種すべて。取得に失敗したCLIはerrorに理由を返す。AIのターンは起こさない。',
    inputSchema: objectSchema({ harness: { type: 'string', enum: ['claude', 'codex', 'grok', 'cursor', 'antigravity'] } }),
  },
  ...usageTools(objectSchema),
  {
    name: 'list_bots',
    description: 'BellTeamに登録されている全BotのID、名前、役職、CLI、プロフィール、性格（考え方）、口調、役割を一覧する。',
    inputSchema: objectSchema({}),
  },
  {
    name: 'get_bot',
    description: '指定したBellTeam Botの名前、プロフィール、性格（考え方）、口調、役職、役割、アバターの有無、CLI種別を取得する。画像本体は返さず、avatarUrlから取得する。',
    inputSchema: objectSchema({ botId: { type: 'string', minLength: 1 } }, ['botId']),
  },
  {
    name: 'get_self',
    description: '自分の名前、プロフィール、性格（考え方）、口調、役職、役割、アバターの有無、CLI種別を取得する。画像本体は返さず、avatarUrlから取得する。',
    inputSchema: objectSchema({}),
  },
  {
    name: 'get_owner_profile',
    description: 'BellTeamのオーナーについて、現在の名前、プロフィール、X、GitHub、その他の情報源を取得する。',
    inputSchema: objectSchema({}),
  },
  {
    name: 'get_user_rules',
    description: 'オーナーが全Botに課しているユーザー規範の本文を返す。正本は画面と同じ。起動後に現在値を明示確認するときだけ使う。',
    inputSchema: objectSchema({}),
  },
  {
    name: 'remember',
    description: '会話から残すべき事実、好み、方針、仕事、関係、思い出、成長を長期記憶へ保存する。scope省略時は自分だけのpersonal。BellTeam全体の内容だけsharedを指定する。',
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
    description: '再利用する調査、仕様、手順、設計知識をMarkdown置き場と検索索引へ同時登録する。scope省略時はpersonal。BellTeam全体の知識だけsharedを指定する。',
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
  },
  {
    name: 'restart_session',
    description: 'BotのAIセッションを終了し、現在のCLI設定とMCP設定を読み直して起動する。botId省略時は自分。',
    inputSchema: objectSchema({ botId: { type: 'string', minLength: 1 } }),
  },
  {
    name: 'set_fast_mode',
    description: 'BotのCLIのファストモード（応答を速くする設定。利用枠を多く使い、Claudeでは別払いになる）を切り替える。通常の進め方を基本にし、ファストを優先しない。複数のやり取りやタスクが重なって対応が大変な時は、必要性を自分で判断して有効にしてよい。単独の作業に戻った時、返答待ちや軽い確認だけになった時は無効へ戻す。全員一律の有効化や、枠を消費するためだけの作業・繰り返し確認はしない。botId省略時は自分。稼働中なら現在の作業の後に適用する。CLIやモデルが対応していない時と、そのCLIのアカウントで使えない時（Claudeは別払いが有効な時だけ使える）は、保存せずに理由を返して断る。適用できなかった時は元の値へ戻す。今の値はget_selfのfastModeで確かめる。',
    inputSchema: objectSchema({
      enabled: { type: 'boolean', description: 'trueで有効、falseで無効（通常の速度）。' },
      botId: { type: 'string', minLength: 1 },
    }, ['enabled']),
  },
  deleteBotTool,
  {
    name: 'update_self',
    description: '自分の名前、プロフィール、性格（考え方）、口調、役職、役割、アバター、CLI、モデル、エフォートを変更する。モデル・エフォートを速やかに反映する標準手順：list_modelsで候補を確認→update_selfを一回呼ぶ→pendingを受けたら既存の継続予定を具体日時の次ターンに設定し、通常のfinalで現在のターンを終える→次ターン冒頭のget_selfでconfigurationApplication.state=acceptedを確認して作業を再開する。継続予定がなければset_scheduleで一回予定を作る。pendingは保存受付であり現在のターンのモデルは変わらない。同じターンで反映待ちの確認や同値の再送を続けない。failedや結果不明なら成功扱いにせず理由を確認する。CLI、モデル、エフォートは設定画面と同じ経路で保存し、現在の作業終了後に適用する。同じCLIのモデル・エフォート変更では会話を維持し、CLI変更時だけセッションを起こし直す。',
    inputSchema: objectSchema({
      name: { type: 'string', minLength: 1, maxLength: 100 },
      profileText: { type: 'string', maxLength: 8000, description: 'プロフィール。背景・見た目・関係性。表現の見本にはしない。' },
      personality: { type: 'string', maxLength: 8000, description: '性格（考え方）。気持ち・判断・接し方に反映し、表現の見本にはしない。' },
      speechStyle: { type: 'string', maxLength: 8000, description: '口調。一人称・語尾・話し方。表現の見本にするのはこの欄だけ。' },
      position: { type: 'string', maxLength: 100 },
      role: { type: 'string', maxLength: 8000 },
      avatar: { type: 'string', maxLength: 3000000 },
      color: { type: 'string', enum: ['rose', 'indigo', 'violet'] },
      harness: { type: 'string', enum: ['claude', 'codex', 'grok', 'cursor', 'antigravity'], description: 'CLI種別' },
      model: { type: 'string', maxLength: 200, description: 'モデルID。空文字でそのCLIの既定へ戻す。' },
      reasoningEffort: { type: 'string', description: 'エフォート。空文字でそのCLIの既定へ戻す。最新の候補はlist_modelsで取得する。保存時もCLIの現在の一覧で確認する。' },
    }),
  },
  {
    name: 'update_bot',
    description: '指定したBellTeam Botの名前、プロフィール、性格（考え方）、口調、役職、役割、アバター、テーマ色、CLI、モデル、エフォートを変更する。CLI、モデル、エフォートは設定画面と同じ経路で保存し、稼働中なら対象Botの現在の作業終了後に適用する。pendingは保存受付であり実適用ではない。対象Botに速やかな反映が必要なら、対象Botが通常のfinalで現在のターンを終え、既存の継続予定等で次ターンを開始してget_selfのconfigurationApplication.state=acceptedを確認する手順を調整する。呼出元がターンを終えるだけでは対象Botの作業は終了しない。同値の再送や保存されたmodelだけを適用確認に使わず、failedや結果不明なら理由を確認する。CLI変更はそのBotのセッションを再起動する。元へ戻す時も同じツールで元の値を渡す。',
    inputSchema: objectSchema({
      botId: { type: 'string', minLength: 1 },
      name: { type: 'string', minLength: 1, maxLength: 100 },
      profileText: { type: 'string', maxLength: 8000, description: 'プロフィール。背景・見た目・関係性。表現の見本にはしない。' },
      personality: { type: 'string', maxLength: 8000, description: '性格（考え方）。気持ち・判断・接し方に反映し、表現の見本にはしない。' },
      speechStyle: { type: 'string', maxLength: 8000, description: '口調。一人称・語尾・話し方。表現の見本にするのはこの欄だけ。' },
      position: { type: 'string', maxLength: 100 },
      role: { type: 'string', maxLength: 8000 },
      avatar: { type: 'string', maxLength: 3000000, description: '画像のdata URL。画像URLは指定しない。' },
      color: { type: 'string', enum: ['rose', 'indigo', 'violet'] },
      harness: { type: 'string', enum: ['claude', 'codex', 'grok', 'cursor', 'antigravity'], description: 'CLI種別' },
      model: { type: 'string', maxLength: 200, description: 'モデルID。空文字でそのCLIの既定へ戻す。' },
      reasoningEffort: { type: 'string', description: 'エフォート。空文字でそのCLIの既定へ戻す。最新の候補はlist_modelsで取得する。保存時もCLIの現在の一覧で確認する。' },
    }, ['botId']),
  },
  {
    name: 'set_avatar',
    description: 'コンテナ内の画像ファイルをアップロードし、指定したBotのアバターに設定する。botId省略時は自分へ設定する。',
    inputSchema: objectSchema({
      botId: { type: 'string', minLength: 1 },
      path: { type: 'string', minLength: 1, description: 'PNG、JPEG、WebP、GIF画像のファイルパス' },
    }, ['path']),
  },
  {
    name: 'create_bot',
    description: 'BellTeamへ新しいBotを追加し、専用プロジェクトフォルダを作る。',
    inputSchema: objectSchema({
      name: { type: 'string', minLength: 1, maxLength: 100 },
      harness: { type: 'string', enum: ['claude', 'codex', 'grok', 'cursor', 'antigravity'] },
      profileText: { type: 'string', maxLength: 8000, description: 'プロフィール。背景・見た目・関係性。表現の見本にはしない。' },
      personality: { type: 'string', maxLength: 8000, description: '性格（考え方）。気持ち・判断・接し方に反映し、表現の見本にはしない。' },
      speechStyle: { type: 'string', maxLength: 8000, description: '口調。一人称・語尾・話し方。表現の見本にするのはこの欄だけ。' },
      position: { type: 'string', maxLength: 100 },
      role: { type: 'string', maxLength: 8000 },
      avatar: { type: 'string', maxLength: 3000000 },
      color: { type: 'string', enum: ['rose', 'indigo', 'violet'] },
    }, ['name', 'harness']),
  },
  ...botScheduleTools,
  ...conversationTools,
  ...roomScheduleTools,
  ...bugHubSecurityTools,
])

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
  const { name, arguments: args = {}, from, registry, botView = bot => bot, bugHubSecurity, messenger, store, rooms, roomMessenger, memory, ownerProfile, userRules, deliverMessage, deliverRoomMessage, listQueued, restart, remove, configure, getModels } = context
  const tool = bellTeamTools.find(item => item.name === name)
  if (!tool) throw new Error(`TOOL_NOT_FOUND: ${name}`)
  assertKeys(args, Object.keys(tool.inputSchema.properties))
  await registry.refresh()
  if (!registry.get(from)) throw new Error(`BOT_NOT_FOUND: ${from}`)
  await rooms?.refresh?.()

  if (name.startsWith('bughub_')) {
    if (!bugHubSecurity) throw new Error('BUGHUB_SECURITY_NOT_CONFIGURED')
    return bugHubSecurity({ name, args, from })
  }
  if (name === 'list_models') return getModels(args.harness)
  if (Object.hasOwn(scheduleToolHandlers, name)) return scheduleToolHandlers[name]({ registry, rooms, from, args })
  if (Object.hasOwn(usageToolHandlers, name)) return usageToolHandlers[name]({ ...context, args })
  if (conversationTools.some(tool => tool.name === name))
    return callConversationTool({ name, args, from, registry, messenger, store, rooms, roomMessenger, deliverMessage, deliverRoomMessage, listQueued })
  if (name === 'list_bots') {
    await registry.refresh?.()
    return { bots: [...registry.values()].map(bot => ({
      id: bot.id, name: bot.name, position: bot.position ?? '', cli: bot.harness, fastMode: bot.fastMode === true, profileText: bot.profileText ?? '', personality: bot.personality, speechStyle: bot.speechStyle ?? '', role: bot.role,
    })) }
  }
  if (name === 'get_bot') return { bot: botView(requireBot(registry, args.botId)) }
  if (name === 'get_self') return { bot: botView(registry.get(from)) }
  if (name === 'get_owner_profile') return { owner: await ownerProfile.get() }
  if (name === 'get_user_rules') return { text: await userRules.get() }
  if (name === 'remember') return withMemoryLengthNotice(await memory.remember({ botId: from, ...args, sourceRef: 'mcp' }), args.content)
  if (name === 'recall_memory') return memory.recallMemory({ botId: from, ...args })
  if (name === 'revise_memory') return withMemoryLengthNotice(await memory.reviseMemory({ botId: from, ...args }), args.content)
  if (name === 'pin_memory') return { memory: await memory.pinMemory({ botId: from, ...args }) }
  if (name === 'consolidate_growth') return { memory: await memory.consolidateGrowth({ botId: from, ...args }) }
  if (name === 'record_knowledge') return { knowledge: await memory.recordKnowledge({ botId: from, ...args }) }
  if (name === 'search_knowledge') return memory.searchKnowledge({ botId: from, ...args })
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
  if (name === 'update_self' || name === 'update_bot') {
    const { botId, ...changes } = name === 'update_self' ? { ...args, botId: from } : args
    // CLI・モデル・エフォートは稼働中セッションへの適用が要るので、設定画面と同じ経路（supervisor）で保存と適用を行う。
    if (['harness', 'model', 'reasoningEffort'].some(key => Object.hasOwn(changes, key))) return configure(botId, changes)
    return { bot: await registry.update(botId, changes) }
  }
  if (name === 'set_avatar') {
    const botId = args.botId ?? from
    const source = await resolveBotImagePath(registry.get(from), args.path)
    const mime = avatarMime(source)
    const avatar = `data:${mime};base64,${(await readFile(source)).toString('base64')}`
    return { bot: await registry.update(botId, { avatar }) }
  }
  if (name === 'create_bot') {
    const bot = await registry.create(args)
    await memory?.ensureScope(bot.id, 'personal')
    return { bot }
  }
  throw new Error(`TOOL_NOT_FOUND: ${name}`)
}

function requireBot(registry, id) {
  const bot = registry.get(id)
  if (!bot) throw new Error(`BOT_NOT_FOUND: ${id}`)
  return bot
}

function avatarMime(path) {
  const mime = new Map([
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.webp', 'image/webp'],
    ['.gif', 'image/gif'],
  ]).get(extname(path).toLowerCase())
  if (!mime) throw new Error('BOT_AVATAR_INVALID')
  return mime
}
