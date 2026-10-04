import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { runtimeHome } from './runtime-home.mjs'

const intervalScheduleProperties = {
  intervalDays: { type: 'integer', minimum: 1, description: 'interval_days用。開始日から何日おきに実行するか。2なら開始日・2日後・4日後。' },
  startDate: { type: 'string', description: 'interval_days用。開始日（YYYY-MM-DD、指定timezoneの暦日）。' },
  time: { type: 'string', description: 'interval_days用。実行時刻（HH:mm）。' },
  intervalHours: { type: 'integer', minimum: 1, maximum: 24, description: 'interval_hours用。毎日の開始時刻から何時間おきに実行するか。' },
  startHour: { type: 'integer', minimum: 0, maximum: 23, description: 'interval_hours用。開始時（含む）。' },
  endHour: { type: 'integer', minimum: 0, maximum: 23, description: 'interval_hours用。終了時（含む）。開始より小さければ翌日、同じなら一回。' },
  minute: { type: 'integer', minimum: 0, maximum: 59, description: 'interval_hours用。実行する分。既定は0。' },
}

export const bellTeamTools = Object.freeze([
  {
    name: 'list_models',
    description: 'BellTeam内蔵のCLIが今返すモデルとエフォートをAitermから取得する。harness省略時は4種すべて。取得に失敗したCLIはerrorに理由を返す。AIのターンは起こさない。',
    inputSchema: objectSchema({ harness: { type: 'string', enum: ['claude', 'codex', 'grok', 'cursor'] } }),
  },
  {
    name: 'get_settings',
    description: 'BellTeamの追加機能の設定と有効状態を取得する。秘密の値は返さない。',
    inputSchema: objectSchema({}),
  },
  {
    name: 'update_settings',
    description: 'BellTeamの追加機能を設定する。秘密の値は引数へ書かずrequest_secretのtoolId=bellteam-settingsで提出されたsecretRequestIdを渡す。未設定の機能は無効のままにできる。',
    inputSchema: objectSchema({
      featureId: { type: 'string', enum: ['routing', 'callBridge', 'cloudflare', 'diagnostics', 'notifications'] },
      enabled: { type: 'boolean' },
      values: objectSchema({
        url: { type: 'string' }, teamDomain: { type: 'string' }, audience: { type: 'string' },
        publicUrl: { type: 'string' }, relayUrl: { type: 'string' },
      }),
      secretRequestId: { type: 'string', description: '自分が依頼し、利用者が提出済みの秘密入力依頼のID。' },
    }, ['featureId']),
  },
  {
    name: 'complete_setup',
    description: '案内役が利用者と初期設定の完了に合意した時に呼ぶ。Webは引き続き無料で利用でき、Appleアプリは通常利用の購読を案内する。',
    inputSchema: objectSchema({}),
  },
  {
    name: 'request_secret',
    description: 'ユーザーへトークン・パスワードの専用入力カードを出す。秘密の値を引数やチャットへ書かない。登録・取消後に通知が届くので、このツールを待ち続けずターンを終える。値は利用者の永続領域へ保存され、通知には保存先だけが入る。',
    inputSchema: objectSchema({
      toolId: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$', description: '利用するツールのID（例: github）' },
      label: { type: 'string', minLength: 1, maxLength: 80, description: '入力する項目名（例: GitHubトークン）' },
      message: { type: 'string', minLength: 1, maxLength: 1000, description: 'ユーザーへの依頼文。必要な理由・用途を書く。秘密の値を書かない。' },
      roomId: { type: 'string', description: 'ルームで依頼するときだけ、そのルームID' },
    }, ['toolId', 'label', 'message']),
  },
  {
    name: 'get_secret_request',
    description: '自分が依頼した秘密情報入力の状態と登録済みの保存先を確認する。値は返さない。保存先を利用するプログラムで読み、標準入力や認証APIへ渡す。cat等でツール出力へ表示しない。',
    inputSchema: objectSchema({ requestId: { type: 'string' } }, ['requestId']),
  },
  {
    name: 'ask_owner',
    description: 'オーナーに裁定や選択を求める時、選択肢のカードをオーナーとの会話画面へ出す。オーナーは選択肢を押すか、allowOtherがtrueなら文章で答える。答えは次のオーナーからのメッセージとして届くので、このツールを待ち続けずターンを終える。',
    inputSchema: objectSchema({
      question: { type: 'string', minLength: 1, maxLength: 2000, description: '尋ねること。判断に要る背景も短く書く。' },
      options: { type: 'array', minItems: 2, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 200 }, description: '選択肢。重複しない文で2〜8個。' },
      allowOther: { type: 'boolean', description: '選択肢以外の答えを文章で受け付けるか。既定はtrue。' },
    }, ['question', 'options']),
  },
  {
    name: 'sendmessage',
    description: '指定したBellTeam Botまたはuserへ直接メッセージを送る。user宛てで画像を提示する時は、回答全文と画像ファイルパスを一度に渡す。Bot宛てはAitermへ直ちに渡し、Aitermが実行中なら現在のターンへ差し込む。runningまたはsteeredは受付済みなので再送しない。',
    inputSchema: objectSchema({
      target: { type: 'string', minLength: 1, description: '宛先Botの名前、Bot ID、またはuser' },
      message: { type: 'string', minLength: 1, description: '送るメッセージ' },
      image: { type: 'string', minLength: 1, description: '任意の画像ファイルパス' },
    }, ['target', 'message']),
  },
  {
    name: 'send_user_message',
    description: 'ユーザーとして指定したBellTeam Botへメッセージを送り、ユーザーとの会話へ記録する。',
    inputSchema: objectSchema({
      target: { type: 'string', minLength: 1, description: '宛先Bot ID' },
      message: { type: 'string', minLength: 1, description: '送るメッセージ' },
    }, ['target', 'message']),
  },
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
    name: 'list_memory_candidates',
    description: 'Throughlineに自動記録された自分の完了会話から、まだ長期記憶として整理していない候補を取得する。内容を読んで記憶するか破棄するか判断する。',
    inputSchema: objectSchema({ limit: { type: 'integer', minimum: 1, maximum: 100 } }),
  },
  {
    name: 'organize_memory_candidate',
    description: '会話候補をAIの判断で長期記憶へ整理する。意味が変わる情報はrevise_memoryを使う。scope省略時はpersonal。',
    inputSchema: objectSchema({
      candidateId: { type: 'string', minLength: 1 },
      memories: {
        type: 'array', minItems: 1,
        items: objectSchema({
          content: { type: 'string', minLength: 1 },
          kind: { type: 'string', enum: ['fact', 'preference', 'policy', 'task', 'config', 'incident', 'relationship', 'episode', 'growth'] },
          scope: { type: 'string', enum: ['personal', 'shared'] },
          importance: { type: 'integer', minimum: 1, maximum: 10 },
        }, ['content']),
      },
    }, ['candidateId', 'memories']),
  },
  {
    name: 'dismiss_memory_candidate',
    description: '長期記憶へ残す必要がない会話候補を整理済みにする。',
    inputSchema: objectSchema({ candidateId: { type: 'string', minLength: 1 } }, ['candidateId']),
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
    description: '個人またはBellTeam共通のRAGを検索する。scope省略時はpersonalで、共通RAGはsharedを明示した時だけ検索する。',
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
    name: 'delete_bot',
    description: 'BotのAIセッションを終了し、プロジェクトフォルダと登録を削除する。botId省略時は自分。',
    inputSchema: objectSchema({ botId: { type: 'string', minLength: 1 } }),
  },
  {
    name: 'update_self',
    description: '自分の名前、プロフィール、性格（考え方）、口調、役職、役割、アバターを変更する。',
    inputSchema: objectSchema({
      name: { type: 'string', minLength: 1, maxLength: 100 },
      profileText: { type: 'string', maxLength: 8000, description: 'プロフィール。背景・見た目・関係性。表現の見本にはしない。' },
      personality: { type: 'string', maxLength: 8000, description: '性格（考え方）。気持ち・判断・接し方に反映し、表現の見本にはしない。' },
      speechStyle: { type: 'string', maxLength: 8000, description: '口調。一人称・語尾・話し方。表現の見本にするのはこの欄だけ。' },
      position: { type: 'string', maxLength: 100 },
      role: { type: 'string', maxLength: 8000 },
      avatar: { type: 'string', maxLength: 3000000 },
      color: { type: 'string', enum: ['rose', 'indigo', 'violet'] },
    }),
  },
  {
    name: 'update_bot',
    description: '指定したBellTeam Botの名前、プロフィール、性格（考え方）、口調、役職、役割、アバター、テーマ色、CLI、モデル、エフォートを変更する。CLI、モデル、エフォートは設定画面と同じ経路で保存し、稼働中なら現在の作業の後に適用する。CLI変更はそのBotのセッションを再起動する。元へ戻す時も同じツールで元の値を渡す。',
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
      harness: { type: 'string', enum: ['claude', 'codex', 'grok', 'cursor'], description: 'CLI種別' },
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
      harness: { type: 'string', enum: ['claude', 'codex', 'grok', 'cursor'] },
      profileText: { type: 'string', maxLength: 8000, description: 'プロフィール。背景・見た目・関係性。表現の見本にはしない。' },
      personality: { type: 'string', maxLength: 8000, description: '性格（考え方）。気持ち・判断・接し方に反映し、表現の見本にはしない。' },
      speechStyle: { type: 'string', maxLength: 8000, description: '口調。一人称・語尾・話し方。表現の見本にするのはこの欄だけ。' },
      position: { type: 'string', maxLength: 100 },
      role: { type: 'string', maxLength: 8000 },
      avatar: { type: 'string', maxLength: 3000000 },
      color: { type: 'string', enum: ['rose', 'indigo', 'violet'] },
    }, ['name', 'harness']),
  },
  {
    name: 'set_schedule',
    description: 'Botの自動実行予定を追加または更新する。一回はkind=onceとat、cron式はkind=cronとexpression、日おきはkind=interval_daysとintervalDays・startDate・time、時間帯内の時間おきはkind=interval_hoursとintervalHours・startHour・endHourを使う。実行内容はpromptかcommandのどちらか一方。AIを起こす必要のない作業（スクリプト実行など）はpromptでなくcommandにする。botId省略時は自分。',
    inputSchema: objectSchema({
      id: { type: 'string', description: '更新する予定ID。新規追加では省略する。' },
      name: { type: 'string', maxLength: 100 },
      kind: { type: 'string', enum: ['once', 'cron', 'interval_days', 'interval_hours'] },
      ...intervalScheduleProperties,
      at: { type: 'string', description: '一回実行のISO日時' },
      expression: { type: 'string', description: '反復実行のcron式' },
      timezone: { type: 'string', description: 'IANA timezone。既定はAsia/Tokyo' },
      prompt: { type: 'string', minLength: 1, maxLength: 8000, description: 'AIへの指示。commandと同時には指定しない。' },
      command: { type: 'string', minLength: 1, maxLength: 8000, description: 'AIを起こさずBotのプロジェクトフォルダでsh -cとして実行するコマンド。失敗した時だけユーザーへ知らせる。' },
      enabled: { type: 'boolean' },
      botId: { type: 'string', minLength: 1, description: '対象Bot ID。省略時は自分。' },
    }, ['kind']),
  },
  {
    name: 'list_schedules',
    description: 'Botの自動実行予定を一覧する。botId省略時は自分。',
    inputSchema: objectSchema({ botId: { type: 'string', minLength: 1, description: '対象Bot ID。省略時は自分。' } }),
  },
  {
    name: 'remove_schedule',
    description: 'Botの自動実行予定を削除する。botId省略時は自分。',
    inputSchema: objectSchema({
      id: { type: 'string', minLength: 1 },
      botId: { type: 'string', minLength: 1, description: '対象Bot ID。省略時は自分。' },
    }, ['id']),
  },
  {
    name: 'list_messages',
    description: '指定したBotのユーザー会話とBot間連絡の履歴を取得する。',
    inputSchema: objectSchema({ botId: { type: 'string', minLength: 1 } }, ['botId']),
  },
  {
    name: 'list_rooms',
    description: '自分が所属するBellTeamルームを一覧する。',
    inputSchema: objectSchema({}),
  },
  {
    name: 'get_room',
    description: 'ルーム名、目的、代表、メンバーを取得する。',
    inputSchema: objectSchema({ roomId: { type: 'string', minLength: 1 } }, ['roomId']),
  },
  {
    name: 'create_room',
    description: '自分を代表としてBellTeamルームを作る。',
    inputSchema: objectSchema({
      name: { type: 'string', minLength: 1, maxLength: 100 },
      purpose: { type: 'string', maxLength: 8000 },
      memberIds: { type: 'array', items: { type: 'string', minLength: 1 } },
    }, ['name', 'memberIds']),
  },
  {
    name: 'update_room',
    description: '代表としてルーム名、目的、代表、メンバーを変更する。',
    inputSchema: objectSchema({
      roomId: { type: 'string', minLength: 1 },
      name: { type: 'string', minLength: 1, maxLength: 100 },
      purpose: { type: 'string', maxLength: 8000 },
      representativeId: { type: ['string', 'null'] },
      memberIds: { type: 'array', items: { type: 'string', minLength: 1 } },
    }, ['roomId']),
  },
  {
    name: 'delete_room',
    description: '代表としてルームの設定、会話履歴、予定を削除する。',
    inputSchema: objectSchema({ roomId: { type: 'string', minLength: 1 } }, ['roomId']),
  },
  {
    name: 'invite_to_room',
    description: '既存Botをルームへ招待する。botId省略時は自分。',
    inputSchema: objectSchema({
      roomId: { type: 'string', minLength: 1 },
      botId: { type: 'string', minLength: 1 },
    }, ['roomId']),
  },
  {
    name: 'leave_room',
    description: '指定したBotをルームから退出させる。botId省略時は自分。',
    inputSchema: objectSchema({
      roomId: { type: 'string', minLength: 1 },
      botId: { type: 'string', minLength: 1 },
    }, ['roomId']),
  },
  {
    name: 'respond_to_room',
    description: '現在処理中のルーム発言への結果を返す。同時に複数のルーム発言を受けた時は、届いたメッセージIDをmessageIdへ指定する。返信者に指定されたBotはaction=replyと本文を指定する。返信者以外は発言を把握してaction=silentを指定する。silentは表示されず、通常の最終回答もルームへ表示されない。posted_with_failed_deliveriesとalready_postedは投稿済みなので再送しない。',
    inputSchema: objectSchema({
      action: { type: 'string', enum: ['reply', 'silent'] },
      messageId: { type: 'string', minLength: 1, description: '同時に複数受信した場合の返信対象メッセージID' },
      message: { type: 'string', minLength: 1, description: 'action=replyの場合の返答全文' },
      image: { type: 'string', minLength: 1, description: 'action=replyの場合の任意の画像ファイルパス' },
      targets: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'この返信に対して必ず返答するBotを手動で指定する。省略時はJevが決める' },
    }, ['action']),
  },
  {
    name: 'sendroommessage',
    description: '所属ルームへ新しい実質的なメッセージを投稿する。発言は全メンバーへ届く。targets省略時はJevが会話の継続と返信者を決める。targets指定時は指定した全員が返答し、それ以外のメンバーはサイレントに把握する。受信したルーム発言への返答にはrespond_to_roomを使う。',
    inputSchema: objectSchema({
      room: { type: 'string', minLength: 1 },
      message: { type: 'string', minLength: 1 },
      image: { type: 'string', minLength: 1, description: '任意の画像ファイルパス' },
      targets: { type: 'array', items: { type: 'string', minLength: 1 } },
    }, ['room', 'message']),
  },
  {
    name: 'list_queued_messages',
    description: 'BellTeamがAitermへ渡して処理中のメッセージを一覧する。botId指定時はそのBot宛てだけを返す。',
    inputSchema: objectSchema({ botId: { type: 'string', minLength: 1 } }),
  },
  {
    name: 'list_room_messages',
    description: '所属ルームの会話履歴を取得する。',
    inputSchema: objectSchema({ roomId: { type: 'string', minLength: 1 } }, ['roomId']),
  },
  {
    name: 'set_room_schedule',
    description: '代表としてルームの自動実行予定を追加または更新する。',
    inputSchema: objectSchema({
      roomId: { type: 'string', minLength: 1 },
      id: { type: 'string' }, name: { type: 'string', maxLength: 100 },
      kind: { type: 'string', enum: ['once', 'cron', 'interval_days', 'interval_hours'] }, at: { type: 'string' },
      ...intervalScheduleProperties,
      expression: { type: 'string' }, timezone: { type: 'string' },
      prompt: { type: 'string', minLength: 1, maxLength: 8000 }, enabled: { type: 'boolean' },
      targets: { type: 'array', items: { type: 'string', minLength: 1 } },
    }, ['roomId', 'kind', 'prompt']),
  },
  {
    name: 'list_room_schedules',
    description: '所属ルームの自動実行予定を一覧する。',
    inputSchema: objectSchema({ roomId: { type: 'string', minLength: 1 } }, ['roomId']),
  },
  {
    name: 'remove_room_schedule',
    description: '代表としてルームの自動実行予定を削除する。',
    inputSchema: objectSchema({ roomId: { type: 'string', minLength: 1 }, id: { type: 'string', minLength: 1 } }, ['roomId', 'id']),
  },
])

// 画像本体（data URL）は1枚で十万文字を超え、CLIの道具の上限を超える。返事では本体を外し、有無と取得先だけを返す。
function withoutAvatarBody(value, avatarUrl) {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'avatar')) return value
  const { avatar, ...rest } = value
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

async function runBellTeamTool({ name, arguments: args = {}, from, registry, messenger, store, rooms, roomMessenger, memory, ownerProfile, userRules, deliverMessage, deliverRoomMessage, listQueued, restart, remove, configure, requestSecret, getSecretRequest, askOwner, getSettings, updateSettings, completeSetup, getModels }) {
  const tool = bellTeamTools.find(item => item.name === name)
  if (!tool) throw new Error(`TOOL_NOT_FOUND: ${name}`)
  assertKeys(args, Object.keys(tool.inputSchema.properties))
  await registry.refresh()
  if (!registry.get(from)) throw new Error(`BOT_NOT_FOUND: ${from}`)
  await rooms?.refresh?.()

  if (name === 'list_models') return getModels(args.harness)
  if (name === 'get_settings') return getSettings()
  if (name === 'update_settings') {
    const { featureId, ...input } = args
    return updateSettings(featureId, { ...input, botId: from })
  }
  if (name === 'complete_setup') return completeSetup({ botId: from })

  if (name === 'request_secret') return requestSecret({ ...args, botId: from })
  if (name === 'ask_owner') return askOwner({ ...args, botId: from })
  if (name === 'get_secret_request') {
    const result = await getSecretRequest(args.requestId)
    if (result.request.botId !== from) throw new Error('SECRET_REQUEST_NOT_FOUND')
    return result
  }
  if (name === 'sendmessage') {
    const { image, ...message } = args
    return (deliverMessage ?? (value => messenger.sendmessage(value)))({
      from, ...message,
      target: args.target === 'user' ? 'user' : resolveBotTarget(registry, args.target),
      image: image ? { path: await resolveBotImagePath(registry.get(from), image) } : null,
    })
  }
  if (name === 'send_user_message') return (deliverMessage ?? (value => messenger.sendmessage(value)))({
    from: 'user', ...args, target: resolveBotTarget(registry, args.target),
  })
  if (name === 'list_bots') {
    await registry.refresh?.()
    return { bots: [...registry.values()].map(bot => ({
      id: bot.id, name: bot.name, position: bot.position ?? '', cli: bot.harness, profileText: bot.profileText ?? '', personality: bot.personality, speechStyle: bot.speechStyle ?? '', role: bot.role,
    })) }
  }
  if (name === 'get_bot') return { bot: requireBot(registry, args.botId) }
  if (name === 'get_self') return { bot: registry.get(from) }
  if (name === 'get_owner_profile') return { owner: await ownerProfile.get() }
  if (name === 'get_user_rules') return { text: await userRules.get() }
  if (name === 'remember') return { memory: await memory.remember({ botId: from, ...args, sourceRef: 'mcp' }) }
  if (name === 'recall_memory') return memory.recallMemory({ botId: from, ...args })
  if (name === 'list_memory_candidates') return memory.listMemoryCandidates({ botId: from, ...args })
  if (name === 'organize_memory_candidate') return memory.organizeMemoryCandidate({ botId: from, ...args })
  if (name === 'dismiss_memory_candidate') return memory.dismissMemoryCandidate({ botId: from, ...args })
  if (name === 'revise_memory') return { memory: await memory.reviseMemory({ botId: from, ...args }) }
  if (name === 'pin_memory') return { memory: await memory.pinMemory({ botId: from, ...args }) }
  if (name === 'consolidate_growth') return { memory: await memory.consolidateGrowth({ botId: from, ...args }) }
  if (name === 'record_knowledge') return { knowledge: await memory.recordKnowledge({ botId: from, ...args }) }
  if (name === 'search_knowledge') return memory.searchKnowledge({ botId: from, ...args })
  if (name === 'restart_session') {
    const botId = args.botId ?? from
    requireBot(registry, botId)
    return restart(botId)
  }
  if (name === 'delete_bot') {
    const botId = args.botId ?? from
    requireBot(registry, botId)
    return remove(botId)
  }
  if (name === 'update_self') return { bot: await registry.update(from, args) }
  if (name === 'update_bot') {
    const { botId, ...changes } = args
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
  if (name === 'set_schedule') {
    const { botId = from, ...schedule } = args
    return { schedule: await registry.setSchedule(botId, schedule) }
  }
  if (name === 'list_schedules') return { schedules: await registry.listSchedules(args.botId ?? from) }
  if (name === 'remove_schedule') {
    await registry.removeSchedule(args.botId ?? from, args.id)
    return { removed: args.id }
  }
  if (name === 'list_messages') {
    requireBot(registry, args.botId)
    return { items: await store.timeline(args.botId) }
  }
  if (name === 'list_rooms') {
    await rooms.refresh()
    return { rooms: [...rooms.values()].filter(room => room.memberIds.includes(from)) }
  }
  if (name === 'get_room') return { room: requireRoomMember(rooms, args.roomId, from) }
  if (name === 'create_room') {
    const memberIds = [...new Set([...args.memberIds, from])]
    return { room: await rooms.create({ name: args.name, purpose: args.purpose ?? '', memberIds, representativeId: from }) }
  }
  if (name === 'update_room') {
    const { roomId, ...changes } = args
    requireRepresentative(rooms, roomId, from)
    return { room: await rooms.update(roomId, changes) }
  }
  if (name === 'delete_room') {
    requireRepresentative(rooms, args.roomId, from)
    await rooms.remove(args.roomId)
    return { removed: args.roomId }
  }
  if (name === 'invite_to_room') {
    const botId = args.botId ?? from
    requireBot(registry, botId)
    const room = requireRoom(rooms, args.roomId)
    return { room: await rooms.update(args.roomId, { memberIds: [...new Set([...room.memberIds, botId])] }) }
  }
  if (name === 'leave_room') {
    const botId = args.botId ?? from
    requireBot(registry, botId)
    const room = requireRoom(rooms, args.roomId)
    return { room: await rooms.update(args.roomId, {
      memberIds: room.memberIds.filter(id => id !== botId),
      representativeId: room.representativeId === botId ? null : room.representativeId,
    }) }
  }
  if (name === 'sendroommessage') {
    const { image, ...message } = args
    return (deliverRoomMessage ?? (value => roomMessenger.sendroommessage(value)))({
      from, ...message,
      ...(args.targets ? { targets: args.targets.map(target => resolveBotTarget(registry, target)) } : {}),
      image: image ? { path: await resolveBotImagePath(registry.get(from), image) } : null,
    })
  }
  if (name === 'respond_to_room') {
    const queue = await listQueued(from)
    const roomMessages = queue.items.filter(item => item.status === 'running' && item.context === 'room')
    if (!args.messageId && roomMessages.length > 1) throw new Error('ROOM_RESPONSE_CONTEXT_AMBIGUOUS')
    let active = roomMessages.find(item => !args.messageId || item.groupId === args.messageId)
    if (!active && args.messageId) {
      await rooms.refresh?.()
      for (const room of rooms.values()) {
        const message = (await rooms.messages(room.id)).find(item => item.id === args.messageId
          && item.deliveries?.some(delivery => delivery.target === from))
        if (message) {
          active = { contextId: room.id, groupId: message.id, from: message.sender.id }
          break
        }
      }
    }
    if (!active) throw new Error('ROOM_RESPONSE_CONTEXT_MISSING')
    const roomId = active.contextId
    requireRoomMember(rooms, roomId, from)
    const received = (await rooms.messages(roomId)).find(item => item.id === active.groupId)
    if (received?.routing?.status !== 'ready') throw new Error('ROOM_ROUTING_NOT_READY')
    const assigned = received.routing.responders.includes(from)
    if (args.action === 'silent') {
      if (args.message || args.image || args.targets) throw new Error('ROOM_SILENT_ARGUMENT_INVALID')
      if (assigned) throw new Error('ROOM_REPLY_EXPECTED')
      return { delivery: 'suppressed' }
    }
    if (args.action !== 'reply') throw new Error('ROOM_REPLY_ACTION_INVALID')
    if (!assigned) throw new Error('ROOM_REPLY_NOT_ASSIGNED')
    if (!args.message && !args.image) throw new Error('ROOM_REPLY_MESSAGE_REQUIRED')
    const { action, image, messageId, ...message } = args
    const replyTargets = args.targets
      ? args.targets.map(target => resolveBotTarget(registry, target))
      : undefined
    const result = await (deliverRoomMessage ?? (value => roomMessenger.sendroommessage(value)))({
      from, room: roomId, responseTo: active.groupId, ...message,
      ...(replyTargets ? { targets: replyTargets } : {}),
      image: image ? { path: await resolveBotImagePath(registry.get(from), image) } : null,
    })
    return { id: result.id, delivery: result.delivery ?? 'posted', ...(result.failedTargets ? { failedTargets: result.failedTargets } : {}) }
  }
  if (name === 'list_queued_messages') return listQueued(args.botId)
  if (name === 'list_room_messages') {
    requireRoomMember(rooms, args.roomId, from)
    return { items: await rooms.messages(args.roomId) }
  }
  if (name === 'set_room_schedule') {
    const { roomId, ...schedule } = args
    requireRepresentative(rooms, roomId, from)
    return { schedule: await rooms.setSchedule(roomId, schedule) }
  }
  if (name === 'list_room_schedules') {
    requireRoomMember(rooms, args.roomId, from)
    return { schedules: await rooms.listSchedules(args.roomId) }
  }
  if (name === 'remove_room_schedule') {
    requireRepresentative(rooms, args.roomId, from)
    await rooms.removeSchedule(args.roomId, args.id)
    return { removed: args.id }
  }
  throw new Error(`TOOL_NOT_FOUND: ${name}`)
}

export async function resolveBotImagePath(bot, input, { home = runtimeHome() } = {}) {
  if (typeof input !== 'string' || input.length === 0) throw new Error('IMAGE_PATH_INVALID')
  if (isAbsolute(input)) return input
  const relative = normalize(input)
  if (relative === '..' || relative.startsWith(`..${sep}`)) throw new Error('IMAGE_PATH_INVALID')
  const projectPath = resolve(bot.project, relative)
  if (await regularFile(projectPath)) return projectPath
  if (bot.harness !== 'grok') return projectPath

  const sessionRoot = join(home, '.grok', 'sessions', encodeURIComponent(bot.project))
  let sessions
  try { sessions = await readdir(sessionRoot, { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return projectPath; throw error }
  const candidates = []
  for (const session of sessions) {
    if (!session.isDirectory()) continue
    const path = join(sessionRoot, session.name, relative)
    try {
      const info = await stat(path)
      if (info.isFile()) candidates.push({ path, modified: info.mtimeMs })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  candidates.sort((a, b) => b.modified - a.modified)
  return candidates[0]?.path ?? projectPath
}

async function regularFile(path) {
  try { return (await stat(path)).isFile() }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

function requireRoomMember(rooms, id, from) {
  const room = requireRoom(rooms, id)
  if (!room.memberIds.includes(from)) throw new Error(`ROOM_MEMBER_REQUIRED: ${id}`)
  return room
}

function requireRoom(rooms, id) {
  const room = rooms.get(id)
  if (!room) throw new Error(`ROOM_NOT_FOUND: ${id}`)
  return room
}

function requireRepresentative(rooms, id, from) {
  const room = requireRoomMember(rooms, id, from)
  if (room.representativeId !== from) throw new Error(`ROOM_REPRESENTATIVE_REQUIRED: ${id}`)
  return room
}

function requireBot(registry, id) {
  const bot = registry.get(id)
  if (!bot) throw new Error(`BOT_NOT_FOUND: ${id}`)
  return bot
}

function resolveBotTarget(registry, target) {
  if (registry.has(target)) return target
  const matches = [...registry.values()].filter(bot => bot.name === target || bot.displayName === target)
  if (matches.length === 1) return matches[0].id
  if (matches.length > 1) throw new Error(`BOT_TARGET_AMBIGUOUS: ${target}`)
  throw new Error(`BOT_NOT_FOUND: ${target}`)
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

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

function assertKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('TOOL_ARGUMENT_INVALID')
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`TOOL_ARGUMENT_INVALID: ${key}`)
  }
}
