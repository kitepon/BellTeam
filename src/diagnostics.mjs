import { createHash, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname } from 'node:path'

const reports = {
  IOS_HANG: ['high', 'Appleアプリが応答しなくなった'],
  IOS_CRASH: ['fatal', 'Appleアプリが異常終了した'],
  IOS_NETWORK_TIMEOUT: ['high', 'Appleアプリの通信が時間切れになった'],
  IOS_NETWORK_FAILURE: ['warn', 'Appleアプリの通信に失敗した'],
  IOS_HTTP_5XX: ['high', 'Appleアプリがサーバーエラーを受け取った'],
  IOS_RESPONSE_INVALID: ['high', 'Appleアプリが応答を読み取れなかった'],
  SERVER_SECRET_FAILED: ['high', '秘密情報の登録処理に失敗した'],
  SERVER_HTTP_500: ['high', 'BellTeamのAPI処理に失敗した'],
  SERVER_PUSH_FAILED: ['high', '端末への通知送信に失敗した'],
  IOS_PUSH_FAILED: ['warn', '端末の通知登録に失敗した'],
}
const modules = new Set(['app', 'session', 'conversation', 'events', 'image', 'bots', 'rooms', 'owner', 'schedules', 'settings', 'queue', 'server', 'secrets', 'notifications'])

export class Diagnostics {
  constructor(file) {
    this.file = file
    this.rows = new Map()
    this.pending = Promise.resolve()
  }

  async initialize() {
    try {
      for (const row of JSON.parse(await readFile(this.file, 'utf8'))) this.rows.set(row.fingerprint, row)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  record(report) {
    const task = this.pending.then(async () => {
      const { code, module, app_version: version, diagnostic_log: log } = report ?? {}
      if (!Object.hasOwn(reports, code) || !modules.has(module)) throw new Error('DIAGNOSTIC_INVALID')
      if (version !== undefined && (typeof version !== 'string' || version.length > 40 || !/^[\w.+() -]+$/u.test(version))) throw new Error('DIAGNOSTIC_INVALID')
      if (log !== undefined && (typeof log !== 'string' || !log.trim() || Buffer.byteLength(log) > 49152)) throw new Error('DIAGNOSTIC_INVALID')
      const fingerprint = createHash('sha256').update(`${code}:${module}`).digest('hex')
      const previous = this.rows.get(fingerprint)
      const [severity, message] = reports[code]
      const row = {
        fingerprint,
        severity,
        message_template: message,
        module,
        category: code,
        occurrence_count: (previous?.occurrence_count ?? 0) + 1,
        last_seen: new Date().toISOString(),
        status: 'open',
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
    if (!['all', 'open', 'resolved'].includes(status) || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('DIAGNOSTIC_INVALID')
    return [...this.rows.values()].filter(row => status === 'all' || row.status === status)
      .sort((a, b) => b.last_seen.localeCompare(a.last_seen)).slice(0, limit)
  }

  setStatus(fingerprint, status) {
    const task = this.pending.then(async () => {
      if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(fingerprint)) throw new Error('DIAGNOSTIC_INVALID')
      const row = this.rows.get(fingerprint)
      if (!row) throw new Error('DIAGNOSTIC_NOT_FOUND')
      row.status = status
      await this.save()
      return row
    })
    this.pending = task.catch(() => {})
    return task
  }

  async save() {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp`
    await writeFile(temporary, JSON.stringify([...this.rows.values()]))
    await rename(temporary, this.file)
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
        return send(response, 200, diagnostics.list(url.searchParams.get('status') ?? 'all', Number(url.searchParams.get('limit') ?? 500)))
      }
      if (request.method === 'POST' && ['/api/admin/logs/resolve', '/api/admin/logs/reopen'].includes(url.pathname)) {
        const body = await readSmallJson(request)
        const status = url.pathname.endsWith('/resolve') ? 'resolved' : 'open'
        return send(response, 200, await diagnostics.setStatus(body.fingerprint, status))
      }
      return send(response, 404, { error: 'NOT_FOUND' })
    } catch (error) {
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
