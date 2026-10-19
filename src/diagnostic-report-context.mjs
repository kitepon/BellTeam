// 既存の診断文脈だけから集約の単位を決める。本文や任意のエラー文字列は使わない。
const operations = new Map([
  ['message_send', 'メッセージ送信'], ['conversation_read', '会話取得'],
  ['member_list_read', 'Bot一覧取得'], ['schedule_read', '予定取得'],
  ['subscription_status_read', '購読状態取得'], ['event_stream_connect', 'SSE接続'],
  ['session_check', 'セッション確認'], ['settings_read', '設定取得'],
])
export const diagnosticCauseCodes = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  'ENOENT', 'EACCES', 'ERR_STREAM_PREMATURE_CLOSE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_ABORTED',
])
const errorTypes = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AggregateError', 'McpError'])
const results = new Map([
  ['network_timeout', '通信時間切れ'], ['connection_lost', '接続切断'],
  ['network_failure', '通信失敗'], ['background_send_expired', '背景送信の期限切れ'],
  ['background_send_unavailable', '背景送信を開始できない'], ['response_invalid', '応答形式の異常'],
  ['http_500_response_selected', 'HTTP500応答を選択'],
])

export function diagnosticFailureDetails(error) {
  const type = error?.constructor?.name
  const code = error?.code
  const cause = error?.cause?.code
  return {
    error_type: errorTypes.has(type) ? type : 'unknown',
    error_code: diagnosticCauseCodes.has(code) ? code : 'unknown',
    cause_code: diagnosticCauseCodes.has(cause) ? cause : 'unknown',
  }
}

export function diagnosticReportContext(log) {
  if (typeof log !== 'string') return null
  const fields = new Map()
  for (const line of log.split('\n')) {
    const match = /^(scope|operation|actual_result|failure_stage|error_type|error_code|cause_code)=(.*)$/u.exec(line)
    if (!match) continue
    // 曖昧な重複項目をどちらか一方に決めない。
    if (fields.has(match[1])) return null
    fields.set(match[1], match[2])
  }
  const scope = fields.get('scope'), operation = fields.get('operation'), actual = fields.get('actual_result')
  if (!['server_request', 'app_request'].includes(scope) || !operations.has(operation)) return null
  if (!['network_timeout', 'connection_lost', 'network_failure', 'background_send_expired',
    'background_send_unavailable', 'response_invalid', 'http_500_response_selected'].includes(actual)
    && !/^http_5\d\d$/u.test(actual ?? '')) return null
  const known = (key, allowed) => allowed.has(fields.get(key)) ? fields.get(key) : 'unknown'
  const stage = known('failure_stage', new Set(['dispatch', 'mcp_connect', 'mcp_call']))
  const type = known('error_type', errorTypes)
  const code = known('error_code', diagnosticCauseCodes), cause = known('cause_code', diagnosticCauseCodes)
  const context = { scope, operation, actual_result: actual, failure_stage: stage, error_type: type, error_code: code, cause_code: cause }
  // 同じエラー名でもGET/POST・機能・観測結果・例外の段/符号が違えば別の報告。
  const result = results.get(actual) ?? `HTTP${actual.slice(5)}`
  return { key: JSON.stringify(context), context, description: `操作=${operations.get(operation)}、結果=${result}、原因=未特定` }
}
