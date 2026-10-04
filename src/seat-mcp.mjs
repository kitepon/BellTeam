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
export const BELLTEAM_MCP_PATH = '/mcp'
export const CALL_BRIDGE_MCP_PATH = '/mcp/call-bridge'
export const CALLER_ID_HEADER = 'X-Call-Bridge-Caller-Id'

const INSTRUCTIONS = 'BellTeamのBot、プロフィール、アバター、予定、直接会話、ルーム、長期記憶、RAGはこのMCPで扱う。端末を直接操作しない。Botへの個別連絡はsendmessage、ルームへの新規投稿はsendroommessage、受信したルーム発言への返答または沈黙はrespond_to_roomを使う。同時に複数のルーム発言を受けた時はrespond_to_roomのmessageIdへ届いたメッセージIDを指定する。ルームで返答不要ならaction=silentを選び、沈黙する旨を投稿しない。targetsには処理が必要なBotだけを指定し、特定の一人だけに必要な連絡はsendmessageを使う。Bot宛てのメッセージはAitermへ直ちに渡し、Aitermが差し込みか新規ターンを決める。runningまたはsteeredは受付済みなので再送しない。長期記憶とRAGは起動時に一括読込せず、必要な時だけ検索する。ユーザー規範の現在値の確認はget_user_rulesを使う。トークン・パスワードの受取はrequest_secretで専用入力を依頼する。オーナーに裁定や選択を求める時はask_ownerで選択肢のカードを出し、答えは次のメッセージで受け取る。オーナーの判断・承認・操作が必要な時は、Approval Boxのrequest_decisionでも申請する。値を通常チャットで求めず、保存ファイルを表示せず、利用するプログラムへ直接読み込ませる。'

export function seatBotId(request, bots) {
  const value = request.headers[SEAT_HEADER.toLowerCase()]
  return typeof value === 'string' && bots.has(value) ? value : null
}

// 道具のうち、配送・設定・再起動は本体のAPIと同じ経路を通す。
export function internalApi(port, request = fetch) {
  const call = async (path, body, method = 'POST') => {
    const response = await request(`http://127.0.0.1:${port}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error ?? `HTTP_${response.status}`)
    return result
  }
  return {
    deliverMessage: value => call('/api/deliveries/direct', value),
    deliverRoomMessage: value => call('/api/deliveries/room', value),
    listQueued: async botId => {
      const result = await call('/api/queue', undefined, 'GET')
      return { items: botId ? result.items.filter(item => item.botId === botId) : result.items }
    },
    requestSecret: value => call('/api/secret-requests', value),
    getSecretRequest: id => call(`/api/secret-requests/${encodeURIComponent(id)}`, undefined, 'GET'),
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
export function createSeatMcp({ bots, tools, callBridge = () => null }) {
  const relays = new Set()
  const handle = async (request, response, url) => {
    if (url.pathname !== BELLTEAM_MCP_PATH && url.pathname !== CALL_BRIDGE_MCP_PATH) return reply(response, 404, { error: 'NOT_FOUND' })
    // 名札が無い・展開前の文字列のまま・台帳に無い要求は、どちらの入口でも席を決めずに拒む。
    // 403 は返さない。Claude Code は 403 を「認証が要る」と判定して、全席共有の ~/.claude/mcp-needs-auth-cache.json へ
    // サーバー名で記録し、その後しばらく本物の席の接続まで飛ばす（2026-10-04、試験用の席1つで2席が道具なしで起きた）。
    const from = seatBotId(request, bots)
    if (!from) return reply(response, 400, { error: 'BELLTEAM_SEAT_UNRESOLVED' })
    if (url.pathname === CALL_BRIDGE_MCP_PATH) return relayCallBridge(request, response, { from, callBridge, relays })
    if (request.method !== 'POST') return reply(response, 405, { error: 'METHOD_NOT_ALLOWED' }, { allow: 'POST' })
    const server = new Server({ name: 'bellteam', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: bellTeamTools }))
    server.setRequestHandler(CallToolRequestSchema, async call => ({
      content: [{ type: 'text', text: JSON.stringify(await callBellTeamTool({ ...tools, name: call.params.name, arguments: call.params.arguments, from })) }],
    }))
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
async function relayCallBridge(request, response, { from, callBridge, relays }) {
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

async function readBytes(request, maxBytes = 16 * 1024 * 1024) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > maxBytes) throw new Error('REQUEST_TOO_LARGE')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readBody(request) {
  try { return JSON.parse((await readBytes(request)).toString('utf8')) }
  catch (error) { throw error.message === 'REQUEST_TOO_LARGE' ? error : new Error('INVALID_JSON') }
}

function reply(response, status, value, headers = {}) {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), ...headers })
  response.end(body)
}
