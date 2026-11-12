// 席のCLIがHTTPでつなぐMCPの入口。supervisorの内部入口（loopback）だけで開く。
// 席ごとにnodeを起こさないよう、bellteamの道具と通話ブリッジへの中継をここで受ける。
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'

import { bellTeamTools, callBellTeamTool, forkWritesProject } from './mcp-tools.mjs'
import { readJson } from './http-response.mjs'

// 席の名札。各CLIの設定が、席のCLIの環境変数 AITERM_SESSION_ID をこのヘッダへ写す（harness-config.mjs）。
// Aitermは席のCLIを Bot ID（アカウント席は `<botId>-<1st|2nd>-<base36>`）の名前のセッションで起こし、この変数をセッションごとに必ず付ける。
// 席が起こした子は自分のセッション名を持つので、台帳に無い名札になる。
export const SEAT_HEADER = 'X-Bellteam-Seat'
export const SEAT_VARIABLE = 'AITERM_SESSION_ID'
export const LAUNCH_HEADER = 'X-Bellteam-Launch-Id'
export const LAUNCH_VARIABLE = 'AITERM_AGENT_LAUNCH_ID'
export const BELLTEAM_MCP_PATH = '/mcp'
export const CALL_BRIDGE_MCP_PATH = '/mcp/call-bridge'
export const CALLER_ID_HEADER = 'X-Call-Bridge-Caller-Id'
export const REMOTE_SEAT_MCP_PATH = '/api/seat-mcp'

// SM06: the tool list is frozen per process, so its digest changes only with a body restart (integration README C5).
export const SEAT_TOOLS_DIGEST = createHash('sha256').update(JSON.stringify(bellTeamTools)).digest('hex')
// SM07: idle sessions are closed on the next initialize.
export const SEAT_SESSION_IDLE_MS = 6 * 60 * 60 * 1000

const INSTRUCTIONS = 'BellTeamのBot、プロフィール、アバター、予定、直接会話、ルーム、長期記憶、RAGはこのMCPで扱う。セキュリティの問題（SEC番号の所見）の一覧・詳細・登録・編集・完了・再開は、bughub_で始まる道具でBugHubへ記録する。'

// Bot ids the seat name can speak for: the name itself, then for an account seat
// (`<botId>-<1st|2nd>-<base36>`, execution harness-accounts ACCOUNT_SLOTS) the Bot id before that suffix.
// A fork session name (`<mainSession>-fork-<12hex>`) never speaks by name; only execution's forkSeat registry
// or a fork credential makes it a seat (remote-seat-ingress.md SK02).
export function seatCandidates(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value) || value.includes('-fork-')) return []
  const account = /^(.+)-(?:1st|2nd)-[a-z0-9]+$/u.exec(value)?.[1]
  return account ? [value, account] : [value]
}

export function seatBotId(request, bots) {
  return seatCandidates(request.headers[SEAT_HEADER.toLowerCase()]).find(id => bots.has(id)) ?? null
}

// Availability failures remain 503; only a confirmed missing member is unresolved.
export async function resolveSeatBotId(request, bots) {
  if (typeof bots.readMember !== 'function') return seatBotId(request, bots)
  for (const id of seatCandidates(request.headers[SEAT_HEADER.toLowerCase()])) {
    try { if ((await bots.readMember(id)).id === id) return id }
    catch (error) { if (error.code !== 'BOT_NOT_FOUND' || error.status !== 404) throw error }
  }
  return null
}

// SK07: the internal HTTP API's seat. A running fork (execution's forkSeat registry) speaks for its Bot on every
// method; its project-folder writes are refused per tool at the seat MCP (SK04), not here.
export async function resolveInternalSeat(request, bots, forkSeat) {
  const botId = await resolveSeatBotId(request, bots)
  const name = request.headers[SEAT_HEADER.toLowerCase()]
  if (botId || typeof forkSeat !== 'function' || typeof name !== 'string' || !name.includes('-fork-')) return { botId, fork: null }
  let fork
  try { fork = await forkSeat(name) ?? null }
  catch { throw Object.assign(new Error('EXECUTION_UNAVAILABLE'), { code: 'EXECUTION_UNAVAILABLE', status: 503 }) }
  if (!fork) return { botId: null, fork: null }
  const id = await memberId(fork.botId, bots)
  return id ? { botId: id, fork } : { botId: null, fork: null }
}

// A runtime claim captured at HTTP ingress, never a verified execution or a model argument.
// sourceSession is the real Aiterm session name (an account seat keeps its suffix), not the Bot id.
export function seatExecutionSource(request, bots) {
  const sourceSession = seatBotId(request, bots) ? request.headers[SEAT_HEADER.toLowerCase()] : null
  const value = request.headers[LAUNCH_HEADER.toLowerCase()]
  const launch = sourceSession && typeof value === 'string' && /^[0-9a-f]{32}$/u.test(value)
    ? { session_id: sourceSession, launch_id: value } : null
  return { sourceSession, source: { launch, boundary: null } }
}

// LAN seat MCP on the public listener (remote-seat-ingress.md RS05-RS07). The seat name comes from the
// credential binding, never from the caller's headers; the launch header stays today's runtime claim.
export function createRemoteSeatIngress({ credentials, bots, seatMcp }) {
  const seatKey = SEAT_HEADER.toLowerCase()
  return async (request, response, url) => {
    const binding = await credentials.verify(request.headers.authorization)
    delete request.headers.authorization
    delete request.headers[seatKey]
    if (!binding) return reply(response, 400, { error: 'BELLTEAM_SEAT_UNRESOLVED' })
    request.headers[seatKey] = binding.sessionName
    const path = url.pathname === REMOTE_SEAT_MCP_PATH ? BELLTEAM_MCP_PATH : CALL_BRIDGE_MCP_PATH
    // SK03: a fork credential names its Bot; the fork name itself never resolves (SK02).
    if (binding.kind === 'fork') return seatMcp()(request, response, new URL(`${path}${url.search}`, url), { botId: binding.botId })
    let from
    try { from = await resolveSeatBotId(request, bots) }
    catch (error) { return reply(response, error.status ?? 503, { error: error.code ?? 'MEMBERS_UNAVAILABLE' }) }
    if (from !== binding.botId) return reply(response, 400, { error: 'BELLTEAM_SEAT_UNRESOLVED' })
    return seatMcp()(request, response, new URL(`${path}${url.search}`, url))
  }
}

// RS05: the container-loopback listener that Aiterm's SSH reverse forward targets. Only the two seat MCP paths; no other API.
export function createRemoteSeatServer(ingress) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://bellteam.local')
      if (url.pathname !== REMOTE_SEAT_MCP_PATH && url.pathname !== `${REMOTE_SEAT_MCP_PATH}/call-bridge`) return reply(response, 404, { error: 'NOT_FOUND' })
      return await ingress(request, response, url)
    } catch (error) {
      if (!response.headersSent) reply(response, error?.status ?? 500, { error: error?.code ?? 'INTERNAL_ERROR' })
      else response.destroy()
    }
  })
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
    deliverForkInquiry: value => call('/api/deliveries/fork', executionSource ? { ...value, executionSource } : value),
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
// forkSeat(sessionName) -> {botId, forkId} | null: execution's live registry of local fork seats (SK01).
export function createSeatMcp({ bots, tools, toolsForSource = () => ({}), runTool = (_from, operation) => operation(), callBridge = () => null, assertWorkAllowed = () => {}, admitWork = () => assertWorkAllowed, forkSeat = () => null, now = Date.now }) {
  const relays = new Set()
  // SM01: session id -> { transport, seat, lastSeen }; memory only, so a body restart empties it (SM03).
  const sessions = new Map()
  const createServer = ({ from, fork, executionSource }) => {
    // SM08: the session keeps only the capability advertisement; each call re-selects the current execution generation.
    const scoped = () => ({ ...tools, ...toolsForSource(executionSource), fork: Boolean(fork) })
    const server = new Server({ name: 'bellteam', version: '0.1.0' }, { capabilities: { tools: { listChanged: true },
      experimental: { 'ai.bellteam/tools.v1': { digest: SEAT_TOOLS_DIGEST },
        ...(scoped().configureFromMcp ? { 'ai.aiterm/handoff.v1': { version: 1, tools: ['update_self'] } } : {}) },
    }, instructions: INSTRUCTIONS })
    // SK04: a fork lists every tool; only a call that writes inside a Bot project folder is refused.
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: bellTeamTools }))
    server.setRequestHandler(CallToolRequestSchema, async (call, fullExtra) => {
      if (fork && forkWritesProject(call.params.name, call.params.arguments)) throw new Error(`FORK_PROJECT_WRITE_REFUSED: ${call.params.name}`)
      let handoffMetadata = null
      const scopedTools = scoped()
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
    return server
  }
  const closeIdle = () => {
    for (const [id, session] of sessions) if (now() - session.lastSeen > SEAT_SESSION_IDLE_MS) { sessions.delete(id); session.transport.close().catch(() => {}) }
  }
  // fork: {botId} from a remote fork credential (SK03); otherwise the local registry is asked first (SK01).
  const handle = async (request, response, url, fork = null) => {
    if (url.pathname !== BELLTEAM_MCP_PATH && url.pathname !== CALL_BRIDGE_MCP_PATH) return reply(response, 404, { error: 'NOT_FOUND' })
    // 名札が無い・展開前の文字列のまま・台帳に無い要求は、どちらの入口でも席を決めずに拒む。
    // 403 は返さない。Claude Code は 403 を「認証が要る」と判定して、全席共有の ~/.claude/mcp-needs-auth-cache.json へ
    // サーバー名で記録し、その後しばらく本物の席の接続まで飛ばす（2026-10-04、試験用の席1つで2席が道具なしで起きた）。
    let from
    try {
      if (!fork) {
        const name = request.headers[SEAT_HEADER.toLowerCase()]
        try { fork = typeof name === 'string' ? await forkSeat(name) ?? null : null }
        catch { return reply(response, 503, { error: 'EXECUTION_UNAVAILABLE' }) }
      }
      from = fork ? await memberId(fork.botId, bots) : await resolveSeatBotId(request, bots)
    }
    catch (error) { return reply(response, error.status ?? 503, { error: error.code ?? 'MEMBERS_UNAVAILABLE' }) }
    if (!from) return reply(response, 400, { error: 'BELLTEAM_SEAT_UNRESOLVED' })
    if (url.pathname === CALL_BRIDGE_MCP_PATH) {
      let check
      try { check = admitWork(); check() }
      catch (error) { return reply(response, error.status ?? 502, { error: error.code ?? 'CALL_BRIDGE_UNAVAILABLE' }) }
      return relayCallBridge(request, response, { from, callBridge, relays, assertWorkAllowed: check })
    }
    const executionSource = fork ? forkExecutionSource(request) : seatExecutionSource(request, bots)
    // The session belongs to the seat that opened it: same seat name, Bot and fork.
    const seat = JSON.stringify([request.headers[SEAT_HEADER.toLowerCase()] ?? null, from, fork?.forkId ?? fork?.botId ?? null])
    const sessionId = request.headers['mcp-session-id']
    if (typeof sessionId === 'string') {
      const session = sessions.get(sessionId)
      // SM03: unknown (body restarted, closed) or another seat's id -> 404; the client initializes again and re-lists.
      if (!session || session.seat !== seat) return reply(response, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null })
      session.lastSeen = now()
      return session.transport.handleRequest(request, response, request.method === 'POST' ? await readBody(request) : undefined)
    }
    if (request.method !== 'POST') return reply(response, 405, { error: 'METHOD_NOT_ALLOWED' }, { allow: 'POST' })
    const body = await readBody(request)
    const server = createServer({ from, fork, executionSource })
    if (isInitializeRequest(body)) {
      // SM01: a session per initialize.
      closeIdle()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true,
        onsessioninitialized: id => { sessions.set(id, { transport, seat, lastSeen: now() }) } })
      transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); server.close().catch(() => {}) }
      await server.connect(transport)
      return transport.handleRequest(request, response, body)
    }
    // SM04: a seat connected before sessions existed keeps the stateless path: one server per request.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    response.once('close', () => { server.close().catch(() => {}) })
    await server.connect(transport)
    await transport.handleRequest(request, response, body)
  }
  // 中継の流れは自分からは終わらない。本体を止める時にここで終える（CLIは再接続する）。セッションのSSEも閉じる（SM07）。
  handle.close = () => {
    for (const end of relays) end()
    for (const [id, session] of sessions) { sessions.delete(id); session.transport.close().catch(() => {}) }
  }
  return handle
}

async function memberId(id, bots) {
  if (typeof id !== 'string') return null
  if (typeof bots.readMember !== 'function') return bots.has(id) ? id : null
  try { return (await bots.readMember(id)).id === id ? id : null }
  catch (error) { if (error.code === 'BOT_NOT_FOUND' && error.status === 404) return null; throw error }
}

// SK08 (N102 fork-inquiry): askerSeat on a delivery POST comes only from the resolved seat; a body copy is dropped.
export async function bindAskerSeat(request, fork) {
  const body = await readJson(request)
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    delete body.askerSeat
    if (fork) body.askerSeat = { kind: 'fork', forkId: fork.forkId }
  }
  const bytes = Buffer.from(JSON.stringify(body))
  // The delivery API reads the request with for-await; hand it the rewritten body instead of the consumed stream.
  request[Symbol.asyncIterator] = async function* () { yield bytes }
}

// SK06: the fork's own session name; the launch header stays today's runtime claim.
export function forkExecutionSource(request) {
  const sourceSession = request.headers[SEAT_HEADER.toLowerCase()]
  const value = request.headers[LAUNCH_HEADER.toLowerCase()]
  const launch = typeof value === 'string' && /^[0-9a-f]{32}$/u.test(value) ? { session_id: sourceSession, launch_id: value } : null
  return { sourceSession, source: { launch, boundary: null } }
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
