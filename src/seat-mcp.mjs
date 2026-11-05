// 席のCLIがHTTPでつなぐMCPの入口。supervisorの内部入口（loopback）だけで開く。
// 席ごとにnodeを起こさないよう、bellteamの道具と通話ブリッジへの中継をここで受ける。
import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { bellTeamTools, callBellTeamTool } from './mcp-tools.mjs'

// 席の名札。各CLIの設定が、席のCLIの環境変数 AITERM_SESSION_ID をこのヘッダへ写す（harness-config.mjs）。
// Aitermは席のCLIを Bot ID と同じ名前のセッションで起こし、この変数をセッションごとに必ず付ける。
// 席が起こした子は自分のセッション名を持つので、台帳に無い名札になる。
export const SEAT_HEADER = 'X-Bellteam-Seat'
export const SEAT_VARIABLE = 'AITERM_SESSION_ID'
export const LAUNCH_HEADER = 'X-Bellteam-Launch-Id'
export const LAUNCH_VARIABLE = 'AITERM_AGENT_LAUNCH_ID'
export const BELLTEAM_MCP_PATH = '/mcp'
export const CALL_BRIDGE_MCP_PATH = '/mcp/call-bridge'
export const CALLER_ID_HEADER = 'X-Call-Bridge-Caller-Id'

const INSTRUCTIONS = 'BellTeamのBot、プロフィール、アバター、予定、直接会話、ルーム、長期記憶、RAGはこのMCPで扱う。セキュリティの問題（SEC番号の所見）の一覧・詳細・登録・編集・完了・再開は、bughub_で始まる道具でBugHubへ記録する。'

export function seatBotId(request, bots) {
  const value = request.headers[SEAT_HEADER.toLowerCase()]
  return typeof value === 'string' && bots.has(value) ? value : null
}

// Availability failures remain 503; only a confirmed missing member is unresolved.
export async function resolveSeatBotId(request, bots) {
  if (typeof bots.readMember !== 'function') return seatBotId(request, bots)
  const value = request.headers[SEAT_HEADER.toLowerCase()]
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value)) return null
  try { return (await bots.readMember(value)).id === value ? value : null }
  catch (error) { if (error.code === 'BOT_NOT_FOUND' && error.status === 404) return null; throw error }
}

// A runtime claim captured at HTTP ingress, never a verified execution or a model argument.
export function seatExecutionSource(request, bots) {
  const sourceSession = seatBotId(request, bots)
  const value = request.headers[LAUNCH_HEADER.toLowerCase()]
  const launch = sourceSession && typeof value === 'string' && /^[0-9a-f]{32}$/u.test(value)
    ? { session_id: sourceSession, launch_id: value } : null
  return { sourceSession, source: { launch, boundary: null } }
}

// 道具のうち、配送・設定・再起動は本体のAPIと同じ経路を通す。
export function internalApi(port, request = fetch, { executionSource } = {}) {
  const call = async (path, body, method = 'POST') => {
    const response = await request(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { ...(executionSource?.sourceSession ? { [SEAT_HEADER]: executionSource.sourceSession } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const result = await response.json()
    // 符号だけでは、文が打たれたかどうかがBotに伝わらない。APIが付けた案内文も一緒に返す。
    if (!response.ok) {
      const code = result.error ?? `HTTP_${response.status}`
      throw new Error(typeof result.message === 'string' && result.message ? `${code}: ${result.message}` : code)
    }
    return result
  }
  return {
    deliverMessage: value => call('/api/deliveries/direct', executionSource ? { ...value, executionSource } : value),
    deliverRoomMessage: value => call('/api/deliveries/room', executionSource ? { ...value, executionSource } : value),
    listQueued: async botId => {
      const result = await call('/api/queue', undefined, 'GET')
      return { items: botId ? result.items.filter(item => item.botId === botId) : result.items }
    },
    requestSecret: value => call('/api/secret-requests', value),
    getSecretRequest: id => call(`/api/secret-requests/${encodeURIComponent(id)}`, undefined, 'GET'),
    cancelSecretRequest: (id, botId) => call(`/api/secret-requests/${encodeURIComponent(id)}/cancel`, { botId }),
    askOwner: value => call('/api/owner-questions', value),
    getSettings: () => call('/api/settings', undefined, 'GET'),
    updateSettings: (id, value) => call(`/api/settings/${encodeURIComponent(id)}`, value, 'PATCH'),
    completeSetup: value => call('/api/setup/complete', value),
    getModels: harness => call(`/api/models${harness ? `?harness=${encodeURIComponent(harness)}` : ''}`, undefined, 'GET'),
    restart: botId => call(`/api/bots/${botId}/restart`),
    configure: (botId, changes) => call(`/api/bots/${botId}`, changes, 'PATCH'),
    remove: botId => call(`/api/bots/${botId}`, undefined, 'DELETE'),
  }
}

// tools: callBellTeamTool へ渡す依存（台帳・配送・記憶など）。callBridge: () => ({ url, headersFile }) または null。
export function createSeatMcp({ bots, tools, toolsForSource = () => ({}), runTool = (_from, operation) => operation(), callBridge = () => null, assertWorkAllowed = () => {}, admitWork = () => assertWorkAllowed }) {
  const relays = new Set()
  const handle = async (request, response, url) => {
    if (url.pathname !== BELLTEAM_MCP_PATH && url.pathname !== CALL_BRIDGE_MCP_PATH) return reply(response, 404, { error: 'NOT_FOUND' })
    // 名札が無い・展開前の文字列のまま・台帳に無い要求は、どちらの入口でも席を決めずに拒む。
    // 403 は返さない。Claude Code は 403 を「認証が要る」と判定して、全席共有の ~/.claude/mcp-needs-auth-cache.json へ
    // サーバー名で記録し、その後しばらく本物の席の接続まで飛ばす（2026-10-04、試験用の席1つで2席が道具なしで起きた）。
    let from
    try { from = await resolveSeatBotId(request, bots) }
    catch (error) { return reply(response, error.status ?? 503, { error: error.code ?? 'MEMBERS_UNAVAILABLE' }) }
    if (!from) return reply(response, 400, { error: 'BELLTEAM_SEAT_UNRESOLVED' })
    if (url.pathname === CALL_BRIDGE_MCP_PATH) {
      let check
      try { check = admitWork(); check() }
      catch (error) { return reply(response, error.status ?? 502, { error: error.code ?? 'CALL_BRIDGE_UNAVAILABLE' }) }
      return relayCallBridge(request, response, { from, callBridge, relays, assertWorkAllowed: check })
    }
    if (request.method !== 'POST') return reply(response, 405, { error: 'METHOD_NOT_ALLOWED' }, { allow: 'POST' })
    const executionSource = seatExecutionSource(request, bots)
    const scopedTools = { ...tools, ...toolsForSource(executionSource) }
    const server = new Server({ name: 'bellteam', version: '0.1.0' }, { capabilities: { tools: {},
      ...(scopedTools.configureFromMcp ? { experimental: { 'ai.aiterm/handoff.v1': { version: 1, tools: ['update_self'] } } } : {}),
    }, instructions: INSTRUCTIONS })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: bellTeamTools }))
    server.setRequestHandler(CallToolRequestSchema, async (call, fullExtra) => {
      let handoffMetadata = null
      const configure = scopedTools.configureFromMcp ? async (botId, changes) => {
        const result = await scopedTools.configureFromMcp(botId, changes, {
          schema: 'bellteam.mcp-configuration-ingress.v1', actor: { kind: 'bot', botId: from },
          toolName: call.params.name, originalMcpRequestId: fullExtra.requestId,
          expectedLaunch: executionSource.source.launch,
          nativeCall: call.params._meta?.['ai.aiterm/handoff.v1'] ?? null,
          signal: fullExtra.signal, budget: null,
        })
        handoffMetadata = result.handoffMetadata
        return result.value
      } : scopedTools.configure
      const value = await runTool(from, () => callBellTeamTool({ ...scopedTools, configure, name: call.params.name, arguments: call.params.arguments, from }))
      return { content: [{ type: 'text', text: JSON.stringify(value) }],
        ...(handoffMetadata && !fullExtra.signal.aborted ? { _meta: { 'ai.aiterm/handoff.v1': handoffMetadata } } : {}),
      }
    })
    // 接続ごとの状態を持たない。要求ごとに受け口を作り、応答を返したら閉じる。
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    response.once('close', () => { server.close().catch(() => {}) })
    await server.connect(transport)
    await transport.handleRequest(request, response, await readBody(request))
  }
  // 中継の流れは自分からは終わらない。本体を止める時にここで終える（CLIは再接続する）。
  handle.close = () => { for (const end of relays) end() }
  return handle
}

const RELAYED_REQUEST_HEADERS = ['accept', 'content-type', 'content-length', 'last-event-id', 'mcp-protocol-version', 'mcp-session-id', 'mcp-method', 'mcp-name']
const RELAYED_RESPONSE_HEADERS = ['content-type', 'cache-control', 'mcp-session-id']

// 通話ブリッジのMCPへ、要求と応答をためずにそのまま流す。合言葉と発信者の名札はここで付け、
// 席のCLIが付けてきた Authorization と名札は流さない。応答の待ち時間に上限を置かない（黙った流れを切らない）。
async function relayCallBridge(request, response, { from, callBridge, relays, assertWorkAllowed }) {
  const target = callBridge()
  if (!target) return reply(response, 404, { error: 'CALL_BRIDGE_DISABLED' })
  const headers = Object.fromEntries(RELAYED_REQUEST_HEADERS.flatMap(name => request.headers[name] === undefined ? [] : [[name, request.headers[name]]]))
  let credentials
  try { credentials = await readFile(target.headersFile, 'utf8') }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    return reply(response, 502, { error: 'CALL_BRIDGE_AUTH_UNAVAILABLE' })
  }
  for (const line of credentials.split('\n')) {
    const at = line.indexOf(':')
    if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  headers[CALLER_ID_HEADER] = from
  // Reading credentials may overlap ON. Do not begin a new upstream call afterwards.
  try { assertWorkAllowed() }
  catch (error) { return reply(response, error.status ?? 502, { error: error.code ?? 'CALL_BRIDGE_UNAVAILABLE' }) }
  const url = new URL(target.url)
  const upstream = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: request.method, headers }, answer => {
    // 合言葉は席では直せない。401をそのまま返すと、CLIがこの入口へ認証を始めようとする。
    if (answer.statusCode === 401) {
      answer.resume()
      return reply(response, 502, { error: 'CALL_BRIDGE_AUTH_FAILED' })
    }
    response.writeHead(answer.statusCode, Object.fromEntries(RELAYED_RESPONSE_HEADERS.flatMap(name => answer.headers[name] === undefined ? [] : [[name, answer.headers[name]]])))
    // 上流が途中で切れた時（通話ブリッジの再起動など）は、席側の流れも切って再接続させる。
    answer.once('close', () => { if (!answer.complete) response.destroy() })
    answer.pipe(response)
  })
  const end = () => { upstream.destroy(); response.end() }
  relays.add(end)
  response.once('close', () => { relays.delete(end); upstream.destroy() })
  upstream.once('error', error => {
    if (response.headersSent) return response.destroy()
    reply(response, 502, { error: 'CALL_BRIDGE_UNREACHABLE', message: error.code ?? error.message })
  })
  request.pipe(upstream)
}

async function readBytes(request, maxBytes = 4 * 1024 * 1024) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > maxBytes) throw Object.assign(new Error('REQUEST_TOO_LARGE'), { code: 'REQUEST_TOO_LARGE', status: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readBody(request) {
  // This low-level Server does not apply McpServer's maxToolInputElements.
  let elements = 0
  try {
    return JSON.parse((await readBytes(request)).toString('utf8'), (key, value) => {
      if (++elements > 10_000) throw Object.assign(new Error('REQUEST_TOO_LARGE'), { code: 'REQUEST_TOO_LARGE', status: 413 })
      return value
    })
  }
  catch (error) { throw error.message === 'REQUEST_TOO_LARGE' ? error : new Error('INVALID_JSON') }
}

function reply(response, status, value, headers = {}) {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), ...headers })
  response.end(body)
}
