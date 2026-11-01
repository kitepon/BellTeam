// BugHub のセキュリティの問題（SEC 番号の所見）の記録口へ通す道具。
// 道具の中身（項目・検証・履歴・公開する範囲）は BugHub の契約（/api/security/v1）が持つ。ここは、鍵と呼んだ席を付けて送り、
// 返りをそのまま返すだけ。鍵は道具の引数にも返りにも出さない。送り直しはしない（結果が分からない時は、呼んだ席が同じ
// request_id で送り直す。BugHub が同じ要求を1回として扱う）。
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// 鍵と行き先は BugHub の担当が置く。呼ばれるたびに読むので、起こし直しなしで替えられる。
// headers は「名前: 値」の行（x-bughub-security-token）。endpoint はコンテナの中から届く URL を /api/security/v1 まで。
const FOLDER = 'state/bughub'
const ACTOR_HEADER = 'x-bughub-actor'
const TIMEOUT_MS = 30_000

const text = description => ({ type: 'string', minLength: 1, description })
const time = description => ({ type: 'string', description: `${description}（ISO 8601。例: 2026-10-12T13:08:00+09:00）` })
const findingId = { type: 'string', pattern: '^[A-Z][A-Z0-9-]{2,63}$', description: '所見の番号（例: SEC-002）。' }
const requestId = { type: 'string', description: '要求の番号（UUID）。省くと自動で付き、結果に request_id として返る。結果が分からなかった同じ操作を送り直す時だけ、前の番号を渡す。' }
const expectedVersion = { type: 'integer', minimum: 1, description: '読んだ時の version。ほかの席が先に書き換えていたら 409 で断られる。' }
const resolution = {
  type: 'object', additionalProperties: false, required: ['summary', 'verified_at'],
  description: '直った事の記録。',
  properties: {
    summary: text('確かめた結果の要約。画面と通知へ出してよい文だけ。'),
    verified_at: time('確かめた時刻'),
    evidence_ref: { type: 'string', description: '証拠の置き場（この道具でだけ読める。鍵や攻め方の本文は書かない）。' },
    limitations: { type: 'string', description: '確かめていない範囲。' },
  },
}
const editable = {
  target: text('対象の構成。最大160文字の短い識別。複数対象の一覧は summary に記載する。'),
  title: text('題。最大500文字。'),
  summary: text('外へ出してよい要約。最大4000文字。複数対象の一覧はここに記載する。画面と通知へ出る。'),
  severity: { type: 'string', enum: ['fatal', 'high', 'warn', 'info'], description: '重さ（致命・重大・中・軽）。' },
  owners: { type: 'array', items: { type: 'string', pattern: '^bot-[0-9a-f]{8}$' }, description: '直す担当の Bot ID。' },
  source_ref: { type: 'string', description: '正本の置き場（この道具でだけ読める）。' },
  observed_at: time('最後に確かめた時刻'),
  next_check_at: { type: ['string', 'null'], description: '次に確かめる時刻（ISO 8601）。決めていなければ null。' },
}

export const bugHubSecurityTools = Object.freeze([
  {
    name: 'bughub_list_security_findings',
    description: 'BugHub に記録したセキュリティの問題（SEC 番号の所見）の一覧を返す。state を省くと全部。',
    inputSchema: objectSchema({ state: { type: 'string', enum: ['open', 'resolved'] } }),
  },
  {
    name: 'bughub_get_security_finding',
    description: 'セキュリティの問題1件の今の内容と、登録・編集・完了・再開の履歴を返す。',
    inputSchema: objectSchema({ finding_id: findingId }, ['finding_id']),
  },
  {
    name: 'bughub_create_security_finding',
    description: 'セキュリティの問題を BugHub へ登録する。登録した席は BellTeam が記録する。直った後の所見を取り込む時だけ initial_state を resolved にして resolution を付ける。',
    inputSchema: objectSchema({
      request_id: requestId, finding_id: findingId, ...editable,
      discovered_at: time('見つけた時刻'),
      initial_state: { type: 'string', enum: ['open', 'resolved'], description: '省くと open。' },
      resolution,
    }, ['finding_id', 'target', 'title', 'severity', 'summary', 'discovered_at', 'observed_at']),
  },
  {
    name: 'bughub_update_security_finding',
    description: 'セキュリティの問題の内容を直す。patch に入れた項目だけが変わる。番号・状態・見つけた時刻は変えられない。',
    inputSchema: objectSchema({
      request_id: requestId, finding_id: findingId, expected_version: expectedVersion,
      patch: { type: 'object', additionalProperties: false, minProperties: 1, properties: editable, description: '変える項目。' },
    }, ['finding_id', 'expected_version', 'patch']),
  },
  {
    name: 'bughub_resolve_security_finding',
    description: 'セキュリティの問題を「解決」にする。確かめた結果と時刻を記録する。確かめていない範囲は limitations に書く。',
    inputSchema: objectSchema({ request_id: requestId, finding_id: findingId, expected_version: expectedVersion, resolution },
      ['finding_id', 'expected_version', 'resolution']),
  },
  {
    name: 'bughub_reopen_security_finding',
    description: '解決にしたセキュリティの問題を、同じ番号のまま開き直す。',
    inputSchema: objectSchema({
      request_id: requestId, finding_id: findingId, expected_version: expectedVersion,
      reason: text('開き直す訳。'), observed_at: time('確かめた時刻'),
    }, ['finding_id', 'expected_version', 'reason', 'observed_at']),
  },
])

const ROUTES = {
  bughub_list_security_findings: args => ['GET', `/findings${args.state ? `?state=${encodeURIComponent(args.state)}` : ''}`],
  bughub_get_security_finding: args => ['GET', `/findings/${encodeURIComponent(args.finding_id)}`],
  bughub_create_security_finding: args => ['POST', '/findings', args],
  bughub_update_security_finding: ({ finding_id: id, ...body }) => ['PATCH', `/findings/${encodeURIComponent(id)}`, body],
  bughub_resolve_security_finding: ({ finding_id: id, ...body }) => ['POST', `/findings/${encodeURIComponent(id)}/resolve`, body],
  bughub_reopen_security_finding: ({ finding_id: id, ...body }) => ['POST', `/findings/${encodeURIComponent(id)}/reopen`, body],
}

export function createBugHubSecurity({ root, request = fetch }) {
  const folder = join(root, FOLDER)
  return async function callBugHubSecurity({ name, args, from }) {
    const route = ROUTES[name]
    if (!route) throw new Error(`TOOL_NOT_FOUND: ${name}`)
    const [endpoint, credentials] = await Promise.all([read(join(folder, 'endpoint')), read(join(folder, 'headers'))])
    if (!endpoint.trim() || !credentials.trim()) throw new Error('BUGHUB_SECURITY_NOT_CONFIGURED')
    const headers = {}
    for (const line of credentials.split('\n')) {
      const at = line.indexOf(':')
      if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim()
    }
    // 呼んだ席は、BellTeam が名札から決めた Bot ID。道具の引数からは受け取らない。
    headers[ACTOR_HEADER] = from
    const [method, path, input] = route(args)
    const writes = input !== undefined
    const body = writes ? { ...input, request_id: input.request_id ?? randomUUID() } : undefined
    const note = writes ? ` request_id=${body.request_id}` : ''
    let response
    try {
      response = await request(`${endpoint.trim().replace(/\/+$/u, '')}${path}`, {
        method, signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: writes ? { ...headers, 'content-type': 'application/json' } : headers,
        ...(writes ? { body: JSON.stringify(body) } : {}),
      })
    } catch {
      // 届いたかどうかは分からない。書き込みなら、同じ request_id で送り直せば、BugHub が1回として扱う。
      throw new Error(`BUGHUB_SECURITY_UNREACHABLE:${note || ' BugHub へつながりません'}`)
    }
    const result = await response.json().catch(() => null)
    if (!response.ok) {
      const code = typeof result?.error === 'string' ? result.error : 'no_error_code'
      throw new Error(`BUGHUB_SECURITY_HTTP_${response.status}: ${code}${note}`)
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(`BUGHUB_SECURITY_RESPONSE_INVALID:${note || ' 応答を読めません'}`)
    return writes ? { ...result, request_id: body.request_id } : result
  }
}

async function read(path) {
  try { return await readFile(path, 'utf8') }
  catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}
