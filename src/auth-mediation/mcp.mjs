// Seat MCP tool for Bot calls. The facade (Molly) fills cwd with the seat's project root when the Bot gives none.
export function authMediationTools(objectSchema) {
  return [{
    name: 'auth_exec',
    description: '許可された固定のコマンド1つを、秘密を渡して実行し、終了コードと出力を返す。commandは許可されたコマンドの語そのもの（例: ["gh","release","list","-R","owner/repo"]）で、これでどの秘密を使うかが決まる。argsは実行時に後ろへ足す引数で、許可の判定には使わない。秘密の値は引数にも結果にも出ない（出力に混ざった値は[redacted:名前]に伏せる）。許可が無い・止められている・登録が無い時は、秘密を読まずに断る。標準入力は使えない。',
    inputSchema: objectSchema({
      command: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string', maxLength: 1024 }, description: '許可されたコマンドの語。許可の名前と一字一句同じにする。' },
      args: { type: 'array', maxItems: 256, items: { type: 'string', maxLength: 8192 }, description: '実行時に後ろへ足す引数。許可の判定には使わない。' },
      cwd: { type: 'string', description: '実行する場所。自分のプロジェクトの中。省略すると自分のプロジェクトの根。' },
      timeout_sec: { type: 'integer', minimum: 1, maximum: 3600, description: '最大の実行時間（秒）。既定600。' },
    }, ['command']),
  }]
}

export const authMediationToolHandlers = Object.freeze({
  // The internal HTTP binds the caller to the resolved seat; no Bot ID travels in the arguments.
  auth_exec: ({ args, from, authExec }) => authExec({ botId: from, command: args.command, args: args.args ?? [], cwd: args.cwd, timeoutSec: args.timeout_sec }),
})
