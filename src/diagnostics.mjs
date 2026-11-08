import { createHash, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { constants } from 'node:os'
import { dirname } from 'node:path'
import { diagnosticReportContext } from './diagnostic-report-context.mjs'
import { writeAtomic } from './json-file.mjs'

// 通信の失敗は、エラーの種類や回数だけでは重大度も責任のある箇所も決まらない（ServerManagerの bughub/NETWORK_REPORTING.md）。
// 3つ目がtrueの報告は、送信元（アプリ）が実害と復帰の可否から付けた `severity` を使い、重大度ごとに別の行にする。
// `info`（適切に処理した参考記録）は、その報告の診断に「実害が無い」と「アプリの対処」の行がある時だけ参考として扱い、`resolved` で作る。
// `severity` の無い旧形式の報告と、根拠の無い `info` は未評価。確認できないだけでは下げず、今までの重大度のまま登録して、文面に暫定と出す。
// サーバー自身の報告は、呼ぶ場所ごとに影響が決まるので、codeを分けて重大度を持つ。
const severities = new Set(['fatal', 'high', 'warn', 'info'])
const reports = {
  IOS_HANG: ['high', 'Appleアプリが応答しなくなった'],
  IOS_CRASH: ['fatal', 'Appleアプリが異常終了した'],
  IOS_SCROLL_STALL: ['warn', 'Appleアプリの会話でスクロール入力後も表示位置が変わらなかった'],
  IOS_NETWORK_TIMEOUT: ['high', 'Appleアプリの通信が時間切れになった', true],
  IOS_NETWORK_FAILURE: ['warn', 'Appleアプリの通信に失敗した', true],
  IOS_HTTP_5XX: ['high', 'Appleアプリがサーバーエラーを受け取った', true],
  IOS_RESPONSE_INVALID: ['high', 'Appleアプリが応答を読み取れなかった', true],
  SERVER_SECRET_FAILED: ['high', '秘密情報の登録処理に失敗した'],
  MESSAGE_LOG_INVALID: ['high', '会話ログの破損行を隔離した'],
  SERVER_HTTP_500: ['high', 'BellTeamのAPI処理に失敗した'],
  SERVER_HTTP_503: ['warn', 'BellTeamのAPIが利用不可の応答を返した（原因未確定）'],
  SERVER_MODEL_CONFIGURATION_FAILED: ['high', 'AIのモデル設定を反映できなかった'],
  SERVER_TURN_TRACKING_FAILED: ['high', 'AIの処理終了を追跡できなかった'],
  SERVER_MODULE_CHILD_EXITED: ['high', 'BellTeamの部品が予期せず終了した'],
  GOAL_OPERATION_UNCONFIRMED: ['warn', 'ゴール操作の結果を確認できなかった'],
  // 送信の失敗と設定の反映の失敗を分ける前の記録。保存済みの行のために残し、新しくは記録しない。
  SERVER_PUSH_FAILED: ['high', '端末への通知送信に失敗した'],
  SERVER_PUSH_SEND_FAILED: ['warn', '端末へ通知を届けられなかった（その通知だけ。原因は未確定）'],
  SERVER_PUSH_UNAVAILABLE: ['high', '通知の機能を開始できなかった'],
  SERVER_FEATURE_CONFIGURATION_FAILED: ['high', '起動時に機能の設定を反映できなかった'],
  SERVER_CALL_CONFIGURATION_FAILED: ['warn', '通話の設定をメンバーへ反映できなかった'],
  IOS_PUSH_FAILED: ['warn', '端末の通知登録に失敗した', true],
}
const assessments = { info: '適切に処理した参考記録', warn: '影響あり', high: '影響あり', fatal: '影響あり' }
const referenceGrounds = [/^user_impact=none$/mu, /^app_handling=\S/mu]
const modules = new Set(['app', 'session', 'conversation', 'events', 'image', 'bots', 'rooms', 'owner', 'schedules', 'settings', 'queue', 'server', 'secrets', 'notifications', 'goals'])

const exitComponents = ['conversation', 'usage', 'diagnostics', 'members', 'notifications', 'web-gateway']
const exitSignals = ['SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT', 'SIGKILL', 'SIGPIPE', 'SIGQUIT', 'SIGSEGV', 'SIGTERM']
const exitCodes = ['ERR_IPC_CHANNEL_CLOSED', 'ERR_OUT_OF_RANGE', 'ERR_WORKER_OUT_OF_MEMORY', 'ERR_MODULE_NOT_FOUND']
const exitOrigins = ['peer_failure', 'parent_disconnect', 'exit_control', 'exit_writer_control']
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Object.keys(value).sort().join(',') === keys
const heapNumber = value => Number.isFinite(value) && value >= 0 && value <= 1e9

const restartModules = new Set([...exitComponents, 'memory', 'execution'])
export function validateModuleRestartLimitProblem(value) {
  if (!value || value.kind !== 'module_restart_limit' || !restartModules.has(value.moduleId)) return false
  if (exactKeys(value, 'cleared,kind,moduleId')) return value.cleared === true
  return exactKeys(value, 'count,kind,lastExit,lastReason,moduleId,windowSeconds')
    && Number.isSafeInteger(value.count) && value.count >= 5 && value.windowSeconds === 1800
    && exactKeys(value.lastExit, 'code,signal')
    && (value.lastExit.code === null || Number.isInteger(value.lastExit.code)
      && value.lastExit.code >= -2147483648 && value.lastExit.code <= 2147483647)
    && (value.lastExit.signal === null || typeof value.lastExit.signal === 'string' && Object.hasOwn(constants.signals, value.lastExit.signal))
    && ['process_exit', 'ready_timeout', 'ready_probe_failed', 'recovery_failed'].includes(value.lastReason)
}

export function moduleRestartLimitProblems(rows) {
  return rows.filter(row => row.category === 'module_restart_limit').map(row => {
    if (!validateModuleRestartLimitProblem(row.problem) || row.problem.cleared === true
      || typeof row.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(row.fingerprint)
      || !['open', 'resolved'].includes(row.status)) throw new Error('DIAGNOSTIC_INVALID')
    return { fingerprint: row.fingerprint, status: row.status, ...structuredClone(row.problem) }
  })
}

export function validateModuleChildExitDiagnostic(value) {
  try {
    const origin = value.childExitOrigin
    return exactKeys(value, `${origin === undefined ? '' : 'childExitOrigin,'}component,exitCode,reason,schema,signal,stderrBytes,stderrCodes,stderrTail,stderrTruncated`)
      && (origin === undefined || exactKeys(origin, 'failureCode,origin') && exitOrigins.includes(origin.origin)
        && (origin.failureCode === null || typeof origin.failureCode === 'string' && /^CONVERSATION_[A-Z_]{1,87}$/u.test(origin.failureCode)))
      && value.schema === 'bellteam.module-child-exit.v1' && exitComponents.includes(value.component)
      && (value.exitCode === null || Number.isInteger(value.exitCode) && value.exitCode >= -2147483648 && value.exitCode <= 2147483647)
      && (value.signal === null || exitSignals.includes(value.signal))
      && Array.isArray(value.stderrCodes) && value.stderrCodes.length <= 4
      && value.stderrCodes.every(code => exitCodes.includes(code)) && new Set(value.stderrCodes).size === value.stderrCodes.length
      && ['heap_out_of_memory', 'worker_out_of_memory', 'unknown'].includes(value.reason)
      && Number.isSafeInteger(value.stderrBytes) && value.stderrBytes >= 0 && typeof value.stderrTruncated === 'boolean'
      && Array.isArray(value.stderrTail) && value.stderrTail.length <= 8
      && Array.from(value.stderrTail).every(entry => exactKeys(entry, 'kind') && entry.kind === 'heap_oom'
        || exactKeys(entry, 'afterMiB,beforeMiB,capacityMiB,kind,pauseMs') && entry.kind === 'gc'
          && [entry.beforeMiB, entry.afterMiB, entry.capacityMiB, entry.pauseMs].every(heapNumber))
      && Buffer.byteLength(JSON.stringify(value)) <= 4096
  } catch { return false }
}

export function moduleChildExitReport(value) {
  if (!validateModuleChildExitDiagnostic(value)) throw new Error('DIAGNOSTIC_INVALID')
  const diagnostic_log = JSON.stringify(value)
  // Validate the serialized copy too; caller objects must not change the wire value through toJSON.
  if (!validateModuleChildExitDiagnostic(JSON.parse(diagnostic_log))) throw new Error('DIAGNOSTIC_INVALID')
  return { code: 'SERVER_MODULE_CHILD_EXITED', module: 'server', diagnostic_log }
}

// BugHubが既に受け取る調査注記の形式。不正な注記で原本の取得まで失敗させない。
function validInvestigation(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.summary === 'string' && value.summary.length <= 4000
    && Array.isArray(value.evidence) && value.evidence.length <= 20
    && value.evidence.every(entry => typeof entry === 'string' && entry.length <= 1000)
    && typeof value.updated_at === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/u.test(value.updated_at)
    && Number.isFinite(Date.parse(value.updated_at))
}

export function validateDiagnosticReport(report) {
  const { code, module, app_version: version, diagnostic_log: log, severity: assessed } = report ?? {}
  if (!Object.hasOwn(reports, code) || !modules.has(module)) throw new Error('DIAGNOSTIC_INVALID')
  const bySender = reports[code][2]
  if (bySender && assessed !== undefined && !severities.has(assessed)) throw new Error('DIAGNOSTIC_INVALID')
  if (version !== undefined && (typeof version !== 'string' || version.length > 40 || !/^[\w.+() -]+$/u.test(version))) throw new Error('DIAGNOSTIC_INVALID')
  if (log !== undefined && (typeof log !== 'string' || !log.trim() || Buffer.byteLength(log) > 49152)) throw new Error('DIAGNOSTIC_INVALID')
  if (code === 'SERVER_MODULE_CHILD_EXITED') {
    let detail
    try { detail = JSON.parse(log) } catch { throw new Error('DIAGNOSTIC_INVALID') }
    if (module !== 'server' || Buffer.byteLength(log) > 4096 || !validateModuleChildExitDiagnostic(detail)) throw new Error('DIAGNOSTIC_INVALID')
    return detail
  }
}

export class Diagnostics {
  constructor(file, { investigationsFile = null } = {}) {
    this.file = file
    this.investigationsFile = investigationsFile
    this.investigations = {}
    this.rows = new Map()
    this.pending = Promise.resolve()
  }

  async initialize({ mode = 'bootstrap' } = {}) {
    if (!['bootstrap', 'restore'].includes(mode)) throw new Error('DIAGNOSTIC_INVALID')
    try {
      if (mode === 'bootstrap') await chmod(this.file, 0o600)
      for (const row of JSON.parse(await readFile(this.file, 'utf8'))) this.rows.set(row.fingerprint, row)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    // 設置ごとの任意の調査注記。読めなくても診断の受付や本体を止めない。
    if (this.investigationsFile) {
      this.investigations = {}
      try {
        const notes = JSON.parse(await readFile(this.investigationsFile, 'utf8'))
        if (!notes || typeof notes !== 'object' || Array.isArray(notes)
          || Object.entries(notes).some(([fingerprint, value]) => !/^[a-f0-9]{64}$/u.test(fingerprint) || !validInvestigation(value))) throw new Error('INVALID_INVESTIGATIONS')
        this.investigations = notes
      } catch (error) {
        process.stderr.write('BellTeam: 診断の調査注記を読み込めませんでした。診断原本はそのまま返します。\n')
      }
    }
  }

  record(report) {
    const task = this.pending.then(async () => {
      const { code, module, app_version: version, diagnostic_log: log, severity: assessed } = report ?? {}
      const childExit = validateDiagnosticReport(report)
      const [fixed, template, bySender] = reports[code]
      // 送信元が重大度を付けた報告は、重大度ごとに別の行にする。参考の記録が、影響のあった記録を薄めない。
      const evaluated = Boolean(bySender && assessed) && (assessed !== 'info' || referenceGrounds.every(line => line.test(log ?? '')))
      const severity = evaluated ? assessed : fixed
      const context = diagnosticReportContext(log)
      const legacyKey = evaluated ? `${code}:${module}:${assessed}` : `${code}:${module}${childExit ? `:${childExit.component}` : ''}`
      const fingerprint = createHash('sha256').update(context ? `${legacyKey}:request:${context.key}` : legacyKey).digest('hex')
      const previous = this.rows.get(fingerprint)
      const message = bySender ? `${template}（${evaluated ? assessments[assessed] : '重大度は旧契約の暫定。影響とアプリの対処は未評価'}）` : template
      const row = {
        fingerprint,
        severity,
        message_template: context ? `${message}。${context.description}` : message,
        module,
        category: code,
        occurrence_count: (previous?.occurrence_count ?? 0) + 1,
        last_seen: new Date().toISOString(),
        status: severity === 'info' ? previous?.status ?? 'resolved' : 'open',
        ...(previous?.investigation_note ? { investigation_note: previous.investigation_note } : {}),
        ...(context ? { report_context: context.context } : {}),
        ...(version ? { app_version: version } : previous?.app_version ? { app_version: previous.app_version } : {}),
        ...(log ? {
          diagnostic_log: log,
          diagnostic_log_version: version ?? 'server',
          diagnostic_log_received_at: new Date().toISOString(),
        } : previous?.diagnostic_log ? {
          diagnostic_log: previous.diagnostic_log,
          diagnostic_log_version: previous.diagnostic_log_version,
          diagnostic_log_received_at: previous.diagnostic_log_received_at,
        } : {}),
      }
      this.rows.set(fingerprint, row)
      await this.save()
      return row
    })
    this.pending = task.catch(() => {})
    return task
  }

  list(status = 'all', limit = 500) {
    return [...this.listSnapshot(status, limit)]
  }

  recordModuleRestartLimit(problem) {
    const task = this.pending.then(async () => {
      if (!validateModuleRestartLimitProblem(problem)) throw new Error('DIAGNOSTIC_INVALID')
      const evidence = structuredClone(problem)
      if (!validateModuleRestartLimitProblem(evidence)) throw new Error('DIAGNOSTIC_INVALID')
      const fingerprint = createHash('sha256').update(`module_restart_limit:${evidence.moduleId}`).digest('hex')
      const previous = this.rows.get(fingerprint)
      if (evidence.cleared && (!previous || previous.status === 'resolved')) return previous ? structuredClone(previous) : null
      const row = evidence.cleared ? { ...previous, status: 'resolved' } : {
        ...previous, fingerprint, severity: 'warn', module: 'server', category: 'module_restart_limit',
        message_template: 'BellTeamの部品が30分以内に5回以上再起動しました。再起動は継続しています。',
        occurrence_count: (previous?.occurrence_count ?? 0) + (previous?.status === 'open' ? 0 : 1),
        last_seen: new Date().toISOString(), status: 'open', problem: evidence,
      }
      this.rows.set(fingerprint, row)
      try { await this.save() }
      catch (error) {
        if (previous) this.rows.set(fingerprint, previous)
        else this.rows.delete(fingerprint)
        throw error
      }
      return structuredClone(row)
    })
    this.pending = task.catch(() => {})
    return task
  }

  listSnapshot(status = 'all', limit = 500) {
    if (!['all', 'open', 'resolved'].includes(status) || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('DIAGNOSTIC_INVALID')
    const rows = [...this.rows.values()].filter(row => status === 'all' || row.status === status)
      .sort((a, b) => b.last_seen.localeCompare(a.last_seen)).slice(0, limit)
    // 調査注記は報告元の読取表示にだけ添え、保存原本は変えない。
    const investigations = this.investigations
    return (function* () {
      for (const row of rows) {
        const existing = investigations[row.fingerprint]
        const note = row.investigation_note
        // 既存調査のsummary/evidence/時刻は上限まで無変更で保つ。
        // 後から付けた判定は要求発生時の原文と混ぜず、中央の既存追加文脈へ投影する。
        yield { ...structuredClone(row),
          ...(existing ? { investigation: structuredClone(existing) } : {}),
          ...(note ? { diagnostic_context: {
            ...structuredClone(row.diagnostic_context ?? {}),
            investigation_note: structuredClone(note),
          } } : {}),
        }
      }
    })()
  }

  setStatus(fingerprint, status, { note } = {}) {
    return this.updateInvestigation(fingerprint, { status, note })
  }

  setNote(fingerprint, note) {
    if (note === undefined) return Promise.reject(new Error('DIAGNOSTIC_INVALID'))
    return this.updateInvestigation(fingerprint, { note })
  }

  updateInvestigation(fingerprint, { status, note }) {
    const task = this.pending.then(async () => {
      if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(fingerprint)) throw new Error('DIAGNOSTIC_INVALID')
      if (status !== undefined && !['open', 'resolved'].includes(status)) throw new Error('DIAGNOSTIC_INVALID')
      if (note !== undefined && (typeof note !== 'string' || !note.trim() || note.length > 2000)) throw new Error('DIAGNOSTIC_INVALID')
      const previous = this.rows.get(fingerprint)
      if (!previous) throw new Error('DIAGNOSTIC_NOT_FOUND')
      const row = { ...previous }
      if (status !== undefined) row.status = status
      if (note !== undefined) row.investigation_note = {
        summary: note, updated_at: new Date().toISOString(),
        occurrence_count: row.occurrence_count, status: row.status,
      }
      this.rows.set(fingerprint, row)
      await this.save()
      return row
    })
    this.pending = task.catch(() => {})
    return task
  }

  async save() {
    await mkdir(dirname(this.file), { recursive: true })
    await writeAtomic(this.file, [...this.rows.values()])
  }
}

export function createDiagnosticsAdminServer({ diagnostics, key }) {
  if (!key) throw new Error('BELLTEAM_BUGHUB_KEY_REQUIRED')
  return createServer(async (request, response) => {
    try {
      const supplied = request.headers.authorization ?? ''
      const expected = `Bearer ${key}`
      if (Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return send(response, 401, { error: 'UNAUTHORIZED' })
      const url = new URL(request.url, 'http://bellteam.local')
      if (request.method === 'GET' && url.pathname === '/api/admin/logs') {
        return send(response, 200, await diagnostics.list(url.searchParams.get('status') ?? 'all', Number(url.searchParams.get('limit') ?? 500)))
      }
      if (request.method === 'POST' && ['/api/admin/logs/resolve', '/api/admin/logs/reopen'].includes(url.pathname)) {
        const body = await readSmallJson(request)
        const status = url.pathname.endsWith('/resolve') ? 'resolved' : 'open'
        return send(response, 200, await diagnostics.setStatus(body.fingerprint, status, { note: body.note }))
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/logs/annotate') {
        const body = await readSmallJson(request)
        return send(response, 200, await diagnostics.setNote(body.fingerprint, body.note))
      }
      return send(response, 404, { error: 'NOT_FOUND' })
    } catch (error) {
      if (['DIAGNOSTICS_NOT_ACCEPTING', 'DIAGNOSTICS_NOT_ACCEPTED', 'DIAGNOSTICS_UNAVAILABLE'].includes(error.code))
        return send(response, 503, { error: 'DIAGNOSTICS_UNAVAILABLE' })
      if (error.message === 'DIAGNOSTIC_NOT_FOUND') return send(response, 404, { error: error.message })
      if (error.message === 'DIAGNOSTIC_INVALID' || error.message === 'INVALID_JSON') return send(response, 400, { error: error.message })
      process.stderr.write(`BellTeam diagnostics admin error: ${error.stack ?? error.message}\n`)
      return send(response, 500, { error: 'INTERNAL_ERROR' })
    }
  })
}

async function readSmallJson(request) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > 8192) throw new Error('DIAGNOSTIC_INVALID')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new Error('INVALID_JSON') }
}

function send(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}
