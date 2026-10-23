import { diagnosticFailureDetails } from './diagnostic-report-context.mjs'

// 要求の意味とHTTP処理で観測した失敗。本人の操作や配送結果は推定しない。
export function diagnosticRequestContext({ method, url }, frames = [], error = null) {
  const requestMethod = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method) ? method : 'unknown'
  const path = typeof url === 'string' ? url.split(/[?#]/u, 1)[0] : ''
  let operation = 'unknown'
  let route = '/api/other'
  let expected = 'unknown'
  // 入口の型だけを残す。query、本文、対象ID、任意名は含めない。
  const messages = /^\/api\/(bots|rooms)\/[a-z0-9-]+\/messages$/u.exec(path)
  if (messages && ['GET', 'POST'].includes(requestMethod)) {
    route = `/api/${messages[1]}/:id/messages`
    operation = requestMethod === 'POST' ? 'message_send' : 'conversation_read'
    expected = requestMethod === 'POST' ? 'message_acceptance_response' : 'conversation_data_response'
  } else if (requestMethod === 'POST' && ['/api/deliveries/direct', '/api/deliveries/room'].includes(path)) {
    route = path
    operation = 'message_send'
    expected = 'message_acceptance_response'
  } else if (path === '/api/bots' && requestMethod === 'GET') {
    route = '/api/bots'
    operation = 'member_list_read'
    expected = 'bot_list_response'
  } else if (/^\/api\/(bots|rooms)\/[a-z0-9-]+\/schedules$/u.test(path) && requestMethod === 'GET') {
    route = `/api/${path.split('/')[2]}/:id/schedules`
    operation = 'schedule_read'
    expected = 'schedule_data_response'
  } else if (path === '/api/subscription' && requestMethod === 'GET') {
    route = path
    operation = 'subscription_status_read'
    expected = 'subscription_status_response'
  } else if (path === '/api/events' && requestMethod === 'GET') {
    route = path
    operation = 'event_stream_connect'
    expected = 'sse_stream_response'
  } else if (path === '/api/session' && requestMethod === 'GET') {
    route = path
    operation = 'session_check'
    expected = 'session_status_response'
  } else if (/^\/api\/settings(?:\/[a-z0-9-]+)?$/u.test(path) && requestMethod === 'GET') {
    route = path === '/api/settings' ? path : '/api/settings/:id'
    operation = 'settings_read'
    expected = 'settings_response'
  }
  const stage = frames.some(frame => /\bat (?:async )?AitermClient\.connect\b/u.test(frame)) ? 'mcp_connect'
    : frames.some(frame => /\bat (?:async )?AitermClient\.call\b/u.test(frame)) ? 'mcp_call'
      : frames.some(frame => /\bat (?:async )?AitermTransport\.dispatch\b/u.test(frame)) ? 'dispatch' : 'unknown'
  return [
    'context_source=server_request_handler',
    'scope=server_request',
    `operation=${operation}`,
    'trigger=unknown',
    `request_method=${requestMethod}`,
    `request_route=${route}`,
    `expected_result=${expected}`,
    'expectation_basis=code_contract',
    'actual_result=http_500_response_selected',
    'result_basis=server_observation',
    'http_status=500',
    `failure_stage=${stage}`,
    ...Object.entries(diagnosticFailureDetails(error)).map(([key, value]) => `${key}=${value}`),
    'cause_status=unconfirmed',
    'app_handling=error_response_selected',
    'handling_basis=code_classification',
    'screen_observation=not_observed',
    'response_delivery=unknown',
    'delivery_outcome=unknown',
  ].join('\n')
}
