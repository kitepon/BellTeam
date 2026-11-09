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
    description: '自分の名前、プロフィール、性格（考え方）、口調、役職、役割、アバターの有無、CLI種別を取得する。画像本体は返さず、avatarUrlから取得する。稼働中の設定変更に対する適用記録がある場合だけ、返却するbotにconfigurationApplicationを含める。そのstateはpendingが保存受付・適用待ち、acceptedが設定適用の受付完了、failedが適用処理の失敗（結果不明を含む）を表す。acceptedは次ターンの実モデルを測定した証明ではない。',
    inputSchema: objectSchema({}),
  },
  {
    name: 'get_owner_profile',
    description: 'BellTeamのオーナーについて、現在の名前、プロフィール、X、GitHub、その他の情報源を取得する。',
    inputSchema: objectSchema({}),
  },
  {
    name: 'get_user_rules',
    description: 'オーナーが全Botに課しているユーザー規範の本文を返す。正本は画面と同じ。',
    inputSchema: objectSchema({}),
  },
]

export const memberWriteTools = [
  {
    name: 'update_self',
    description: '自分の名前、プロフィール、性格（考え方）、口調、役職、役割、アバター、CLI、モデル、エフォートを変更する。pendingは保存受付であり現在のターンのモデルは変わらない。CLI、モデル、エフォートは設定画面と同じ経路で保存し、現在の作業終了後に適用する。適用記録はget_selfのbot.configurationApplicationで返し、stateの意味はget_selfの説明に記載する。同じCLIのモデル・エフォート変更では会話を維持し、CLI変更時だけセッションを起こし直す。',
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
    description: '指定したBellTeam Botの名前、プロフィール、性格（考え方）、口調、役職、役割、アバター、テーマ色、CLI、モデル、エフォートを変更する。CLI、モデル、エフォートは設定画面と同じ経路で保存し、稼働中なら対象Botの現在の作業終了後に適用する。pendingは保存受付であり実適用ではない。呼出元がターンを終えるだけでは対象Botの作業は終了しない。保存されたmodelは適用済みを表さない。CLI変更はそのBotのセッションを再起動する。元へ戻す時も同じツールで元の値を渡す。',
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
      terminalId: { type: 'string', maxLength: 128, description: 'リモート席を動かす端末のID。list_terminalsに出ている登録済みのIDをそのまま書く（例 owner-macbook）。空文字でBellTeam内の通常の席へ戻す。projectRootを省くと /Users/<端末のユーザー>/BellTeam/<名前> を使う。通常の席へ戻す時はprojectRootも空文字にする。形が違うとBOT_TERMINAL_ID_INVALID。' },
      projectRoot: { type: 'string', maxLength: 4096, description: 'その端末の上での、席が起動するフォルダの絶対パス（例 /Users/kite/work/app）。BellTeamのコンテナ側のパスではない。/で始め、.や..や空の区切りを含めない（違うとBOT_PROJECT_ROOT_INVALID）。保存の時に端末でフォルダを確かめ、無ければFOLDER_MISSINGで断る（createFolder:trueで作って保存）。端末につながらない時は保存し、結果のfolderCheck.checkedがfalseになる。空文字で通常の席へ戻す時はterminalIdも空文字にする。' },
      createFolder: { type: 'boolean', description: 'trueでその端末にprojectRootのフォルダを作ってから保存する。フォルダが無くてFOLDER_MISSINGで断られた時に使う。' },
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
      terminalId: { type: 'string', maxLength: 128, description: 'リモート席を動かす端末のID。list_terminalsに出ている登録済みのIDをそのまま書く（例 owner-macbook）。空文字でBellTeam内の通常の席へ戻す。projectRootを省くと /Users/<端末のユーザー>/BellTeam/<名前> を使う。通常の席へ戻す時はprojectRootも空文字にする。形が違うとBOT_TERMINAL_ID_INVALID。' },
      projectRoot: { type: 'string', maxLength: 4096, description: 'その端末の上での、席が起動するフォルダの絶対パス（例 /Users/kite/work/app）。BellTeamのコンテナ側のパスではない。/で始め、.や..や空の区切りを含めない（違うとBOT_PROJECT_ROOT_INVALID）。保存の時に端末でフォルダを確かめ、無ければFOLDER_MISSINGで断る（createFolder:trueで作って保存）。端末につながらない時は保存し、結果のfolderCheck.checkedがfalseになる。空文字で通常の席へ戻す時はterminalIdも空文字にする。' },
      createFolder: { type: 'boolean', description: 'trueでその端末にprojectRootのフォルダを作ってから保存する。フォルダが無くてFOLDER_MISSINGで断られた時に使う。' },
    }, ['name', 'harness']),
  },
  {
    name: 'list_member_docs',
    description: '自分のBellTeamプロジェクトにある手順書（docs/配下）とAGENTS.local.mdの一覧を返す。リモート席でもBellTeam側の正本を読む。',
    inputSchema: objectSchema({}),
  },
  {
    name: 'read_member_doc',
    description: '自分のBellTeamプロジェクトの手順書を読む。pathはAGENTS.local.mdかdocs/からの相対パス。',
    inputSchema: objectSchema({ path: { type: 'string', minLength: 1, maxLength: 4096 } }, ['path']),
  },
  {
    name: 'write_member_doc',
    description: '自分のBellTeamプロジェクトの手順書を保存する（全文置換、1MiBまで）。pathはAGENTS.local.mdかdocs/からの相対パス。足りないdocs/配下のフォルダは作る。',
    inputSchema: objectSchema({ path: { type: 'string', minLength: 1, maxLength: 4096 }, content: { type: 'string', maxLength: 1048576 } }, ['path', 'content']),
  },
]

export async function callMemberTool({ name, args = {}, from, registry, botView = bot => bot, configure, memory, ownerProfile, userRules }) {
  if (name === 'list_bots') {
    await registry.refresh?.()
    return { bots: [...registry.values()].map(bot => ({
      id: bot.id, name: bot.name, position: bot.position ?? '', cli: bot.harness, fastMode: bot.fastMode === true, profileText: bot.profileText ?? '', personality: bot.personality, speechStyle: bot.speechStyle ?? '', role: bot.role,
    })) }
  }
  if (name === 'get_bot') return { bot: botView(registry.readMember ? await registry.readMember(args.botId) : requireBot(registry, args.botId)) }
  if (name === 'get_self') return { bot: botView(registry.readMember ? await registry.readMember(from) : registry.get(from)) }
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
  // C6: always the caller's own project; `from` is the ingress-resolved botId, never an argument.
  if (name === 'list_member_docs') return { files: await registry.docs.list(from) }
  if (name === 'read_member_doc') return registry.docs.read(from, args.path)
  if (name === 'write_member_doc') return registry.docs.write(from, args.path, args.content)
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
