import { SubscriptionAccessError } from './subscriptions.mjs'
import { ModelCatalogError } from './model-catalog.mjs'
import { diagnosticRequestContext } from './diagnostic-request-context.mjs'
import { returnedExecutionError } from './execution-bridge.mjs'
import { json } from './http-response.mjs'

// ファストモードを保存しなかった理由。切り替えたBot（MCPの set_fast_mode）と設定画面が、符号だけでなく訳を読めるようにする。
const FAST_MODE_MESSAGES = {
  BOT_FAST_MODE_UNAVAILABLE: 'ファストモードへ切り替えられません。BellTeamに入っているAitermが、ファストモードの切り替えに対応していません。保存は変えていません。',
  BOT_FAST_MODE_UNSUPPORTED: 'ファストモードへ切り替えられません。このBotのCLIとモデルは、ファストモードに対応していません。保存は変えていません。',
  BOT_FAST_MODE_ACCOUNT_UNAVAILABLE: 'ファストモードへ切り替えられません。このBotのCLIのアカウントでは、今はファストモードを使えません。保存は変えていません。',
}
export async function respondHttpError(request, response, error, diagnostics) {
  if (typeof error.code === 'string' && Number.isInteger(error.status)) return json(response, error.status, { error: error.code, message: error.publicMessage ?? error.message, ...(['AUTH_RESPONSE_NOT_ISSUED', 'AUTH_RESPONSE_UNCONFIRMED', 'HARNESS_AUTH_RESPONSE_UNCONFIRMED', 'SETUP_AUTH_RESPONSE_UNCONFIRMED'].includes(error.code) ? { effect: error.effect ?? 'unknown' } : {}) })
  if (error instanceof SubscriptionAccessError) return json(response, error.status, { error: error.code, message: error.message })
  if (request.url?.startsWith('/api/subscription') && ['INVALID_JSON', 'REQUEST_TOO_LARGE'].includes(error.message))
    return json(response, 400, { error: error.message, message: '購入情報または動作確認のリクエスト形式を確認してください。' })
  if (error.message === 'PUSH_DEVICE_INVALID') return json(response, 400, { error: error.message })
  if (['PUSH_NOT_CONFIGURED', 'PUSH_ENVIRONMENT_UNAVAILABLE'].includes(error.message))
    return json(response, 503, { error: error.message })
  if (request.url?.startsWith('/api/secret-requests')) {
    const statuses = {
      SECRET_REQUEST_NOT_FOUND: 404, SECRET_REQUEST_CLOSED: 409,
      SECRET_REQUEST_INVALID: 400, SECRET_VALUE_INVALID: 400, SECRET_ROOM_INVALID: 400,
      BOT_NOT_FOUND: 404, INVALID_JSON: 400, REQUEST_TOO_LARGE: 400,
    }
    if (Object.hasOwn(statuses, error.message)) return json(response, statuses[error.message], { error: error.message })
    // この入口のエラーは、入力値を含み得る例外本文・スタックを記録しない。
    process.stderr.write('BellTeam: 秘密情報の登録処理に失敗しました\n')
    try {
      await diagnostics?.record({ code: 'SERVER_SECRET_FAILED', module: 'secrets', diagnostic_log: '秘密情報の登録処理に失敗。入力値・例外本文は記録しません。' })
    } catch {
      process.stderr.write('BellTeam: 秘密情報処理の診断を保存できませんでした\n')
    }
    return json(response, 500, { error: 'SECRET_OPERATION_FAILED' })
  }
  if (error.code === 'BOT_SESSION_UNCONFIRMED') return json(response, 503, { error: error.code, message: error.publicMessage })
  if (error instanceof ModelCatalogError) return json(response, error.code === 'MODEL_HARNESS_INVALID' ? 400 : 503, { error: error.code, message: error.message })
  if (error.message === 'INVALID_JSON') return json(response, 400, { error: 'INVALID_JSON' })
  if (error.message === 'DIAGNOSTIC_INVALID' || error.message === 'REQUEST_TOO_LARGE') return json(response, 400, { error: error.message })
  if (error.message === 'IMAGE_ASSET_NOT_FOUND') return json(response, 404, { error: error.message })
  if (error.message === 'CHARACTER_SHEET_NOT_FOUND') return json(response, 404, { error: error.message })
  if (error.message === 'CHARACTER_SHEET_INVALID') return json(response, 400, { error: error.message })
  if (/^IMAGE_/u.test(error.message)) return json(response, 400, { error: error.message })
  if (/^(?:BOT|ROOM|SCHEDULE|QUEUE|OWNER_QUESTION)_(?:NOT_FOUND)/u.test(error.message)) return json(response, 404, { error: error.message })
  if (error.message === 'OWNER_QUESTION_CLOSED') return json(response, 409, { error: error.message })
  if (/^OWNER_QUESTION_/u.test(error.message)) return json(response, 400, { error: error.message })
  if (/^BOT_DUPLICATE/u.test(error.message)) return json(response, 409, { error: error.message })
  if (Object.hasOwn(FAST_MODE_MESSAGES, error.message))
    return json(response, 400, { error: error.message, message: `${FAST_MODE_MESSAGES[error.message]}${typeof error.detail === 'string' ? ` 理由：${error.detail}` : ''}` })
  if (/^(?:BOT|ROOM|SCHEDULE|MEMORY|KNOWLEDGE|SEARCH|OWNER)_/u.test(error.message)) return json(response, 400, { error: error.message })
  // fetchの失敗はスタックを持たない。どの要求が何で失敗したかを後から引けるよう、要求と原因の符号も残す（問い合わせ文字列は残さない）。
  const cause = error.cause?.code ?? error.cause?.message
  process.stderr.write(`BellTeam HTTP error: ${request.method} ${String(request.url).split('?')[0]}${cause ? ` cause=${cause}` : ''}: ${error.stack ?? error.message}\n`)
  if (diagnostics && request.url !== '/api/diagnostics') {
    try {
      const frames = String(error.stack ?? '').split('\n').slice(1)
        .filter(line => /^\s*at\s/u.test(line)).slice(0, 20)
        .map(line => line.replaceAll(process.cwd(), '<app>'))
      const report = await diagnostics.record({
        code: 'SERVER_HTTP_500', module: 'server',
        diagnostic_log: `${error.constructor.name}\n${frames.join('\n')}\n${diagnosticRequestContext(request, frames, error)}`,
      })
      if (report) {
        response.setHeader('X-BellTeam-Diagnostic-Fingerprint', report.fingerprint)
        response.setHeader('X-BellTeam-Diagnostic-Occurrence-Count', String(report.occurrence_count))
        response.setHeader('X-BellTeam-Diagnostic-Received-At', report.diagnostic_log_received_at)
      }
    }
    catch (reportError) { process.stderr.write(`BellTeam diagnostics error: ${reportError.stack ?? reportError.message}\n`) }
  }
  // 利用者へ理由を伝えられる失敗（Botを起動できなかった時など）は、その文も返す。記録と状態は他の500と同じ。
  const execution = returnedExecutionError(error.executionError) ?? returnedExecutionError(error)
  if (execution) return json(response, 500, {
    error: execution.code, effect: execution.effect, follow_up: execution.follow_up,
    message: execution.effect === 'possible'
      ? '入力が届いたか確認できません。同じ内容を再送せず、配送履歴と受信側の状態を確認してください。'
      : '今回の入力は送信されていません。原因を確認し、同じ内容を自動再送しないでください。',
  })
  return json(response, 500, { error: 'INTERNAL_ERROR', ...(typeof error.publicMessage === 'string' ? { message: error.publicMessage } : {}) })
}
