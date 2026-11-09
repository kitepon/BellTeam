export function usageTools(objectSchema) {
  return [
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
      description: 'ユーザーへトークン・パスワードの専用入力カードを出す。秘密の値や1Password参照をこの道具の引数へ書かない。カードは保存値または1Password参照を受け付ける。登録・取消後に通知が届く。利用するプログラムには秘密入力の承認済み窓口から解決値を直接渡し、値や参照を会話・ログ・Gitへ出さない。',
      inputSchema: objectSchema({
        toolId: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$', description: '利用するツールのID（例: github）' },
        label: { type: 'string', minLength: 1, maxLength: 80, description: '入力する項目名（例: GitHubトークン）' },
        message: { type: 'string', minLength: 1, maxLength: 1000, description: 'ユーザーへの依頼文。必要な理由・用途を書く。秘密の値を書かない。' },
        roomId: { type: 'string', description: 'ルームで依頼するときだけ、そのルームID' },
      }, ['toolId', 'label', 'message']),
    },
    {
      name: 'get_secret_request',
      description: '自分が依頼した秘密情報入力の状態と、保存値の場合は登録済みの保存先を確認する。値・1Password参照は返さない。',
      inputSchema: objectSchema({ requestId: { type: 'string' } }, ['requestId']),
    },
    {
      name: 'cancel_secret_request',
      description: '自分が依頼した、まだ入力されていない秘密情報入力を取り下げる。要らなくなった依頼のカードを、オーナーの手を借りずに片付ける時に使う。画面のカードは「取消」になる。入力済み・取消済みの依頼と、ほかのBotの依頼は取り下げられない。値は扱わない。',
      inputSchema: objectSchema({ requestId: { type: 'string' } }, ['requestId']),
    },
    {
      name: 'ask_owner',
      description: 'オーナーに裁定や選択を求める時、選択肢のカードをオーナーとの会話画面へ出す。オーナーは選択肢を押すか、allowOtherがtrueなら文章で答える。答えは次のオーナーからのメッセージとして届く。',
      inputSchema: objectSchema({
        question: { type: 'string', minLength: 1, maxLength: 2000, description: '尋ねること。判断に要る背景も短く書く。' },
        options: { type: 'array', minItems: 2, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 200 }, description: '選択肢。重複しない文で2〜8個。' },
        allowOther: { type: 'boolean', description: '選択肢以外の答えを文章で受け付けるか。既定はtrue。' },
      }, ['question', 'options']),
    },
  ]
}

export const usageToolHandlers = Object.freeze({
  get_settings: ({ getSettings }) => getSettings(),
  update_settings: ({ args, from, updateSettings }) => {
    const { featureId, ...input } = args
    return updateSettings(featureId, { ...input, botId: from })
  },
  complete_setup: ({ from, completeSetup }) => completeSetup({ botId: from }),
  request_secret: ({ args, from, requestSecret }) => requestSecret({ ...args, botId: from }),
  ask_owner: ({ args, from, askOwner }) => askOwner({ ...args, botId: from }),
  get_secret_request: async ({ args, from, getSecretRequest }) => {
    const result = await getSecretRequest(args.requestId)
    if (result.request.botId !== from) throw new Error('SECRET_REQUEST_NOT_FOUND')
    return result
  },
  cancel_secret_request: ({ args, from, cancelSecretRequest }) => cancelSecretRequest(args.requestId, from),
})
