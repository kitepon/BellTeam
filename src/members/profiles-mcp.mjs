import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { objectSchema } from '../mcp-schema.mjs'
import { resolveBotImagePath } from '../bot-image-path.mjs'

export const memberReadTools = [
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
]

export const memberWriteTools = [
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
]

export async function callMemberTool({ name, args = {}, from, registry, botView = bot => bot, configure, memory, ownerProfile, userRules }) {
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
