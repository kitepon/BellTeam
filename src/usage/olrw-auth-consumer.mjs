import { constants } from 'node:fs'
import { open, mkdir, realpath, unlink } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { isDeepStrictEqual as equal } from 'node:util'
import { authUi } from '../auth-ui.mjs'

const origins = ['https://claude.ai', 'https://console.anthropic.com', 'https://platform.claude.com']
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(value)
const guideUrl = value => {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && origins.includes(u.origin) } catch { return false }
}
const stopped = Symbol('stopped')
const stop = (reason, outcome = 'not_issued') => Object.assign(new Error('OLRW_AUTH_STOPPED'), { [stopped]: true, reason, outcome })
const syncDirectory = async path => { const fd = await open(path, constants.O_RDONLY); try { await fd.sync() } finally { await fd.close() } }

// Only the management graph may supply these references; no HTTP/MCP input is accepted.
export function createOlrwAuthConsumer({ secretRequests, runDirectory, context, assertAuthorized, auth }) {
  const plan = structuredClone(context)
  if (!plan || !id(plan.runId) || !id(plan.sessionId) || !id(plan.protectedHosted)
    || plan.sessionId === plan.protectedHosted || !id(plan.requesterBotId)
    || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(plan.toolId ?? '')
    || plan.roomId !== null && !id(plan.roomId) || !Number.isFinite(Date.parse(plan.expiresAt))
    || !isAbsolute(runDirectory) || typeof assertAuthorized !== 'function'
    || !['start', 'status', 'respond', 'cleanup'].every(key => typeof auth?.[key] === 'function')) throw stop('invalid_context')
  let state, journal, started = false, closed = false, guideReady = false, activeSignal
  const controller = new AbortController()
  const lockPath = join(runDirectory, 'target.lock')
  const receipt = (outcome, reason) => ({ runId: plan.runId, outcome, reason })
  const deadline = () => Math.min(Date.parse(plan.expiresAt), state?.deadline ?? Infinity, state?.inputDeadline ?? Infinity)
  function check() {
    if (closed || activeSignal?.aborted) throw stop('interrupted')
    if (Date.now() >= deadline()) throw stop('expired')
  }
  async function record() {
    await journal.writeFile(JSON.stringify(state) + '\n')
    await journal.sync()
  }
  async function bounded(promise, until) {
    let timer, abort
    const interrupt = new Promise((_, reject) => {
      timer = setTimeout(() => reject(stop('expired')), Math.max(0, until - Date.now()))
      abort = () => reject(stop('interrupted'))
      activeSignal.addEventListener('abort', abort, { once: true })
      if (activeSignal.aborted) abort()
    })
    try { return await Promise.race([promise, interrupt]) }
    finally { clearTimeout(timer); activeSignal.removeEventListener('abort', abort) }
  }
  async function authorized(action) {
    check()
    try {
      if (await bounded(Promise.resolve().then(() => assertAuthorized(action)), deadline()) !== undefined) throw stop('authorization_invalid')
    } catch (error) { throw error[stopped] ? error : stop('not_authorized') }
    check()
  }
  async function pause(ms) {
    let timer
    try { await bounded(new Promise(resolve => { timer = setTimeout(resolve, ms) }), deadline()) }
    finally { clearTimeout(timer) }
    check()
  }
  function parse(result, action) {
    const r = result?.structuredContent
    if (result?.isError) {
      const expected = action === 'respond' ? 'aiterm.auth-response-error.v1' : 'aiterm.auth-operation-error.v1'
      if (r?.schema === expected && r.harness === 'claude-code' && r.session_id === plan.sessionId
        && (action === 'respond' || r.action === (action === 'cleanup' ? 'cancel' : action))
        && typeof r.code === 'string' && r.code && ['not_issued', 'unknown'].includes(r.effect)
        && (action === 'respond' || ['status', 'cleanup'].includes(action)
          && Object.keys(r).sort().join(',') === 'action,code,effect,harness,schema,session_id'
          && r.code === (r.effect === 'not_issued' ? 'AGENT_AUTH_OPERATION_NOT_ISSUED' : 'AGENT_AUTH_OPERATION_UNKNOWN')))
        throw stop('native_' + r.effect, r.effect)
      throw stop('invalid_receipt', 'unknown')
    }
    if (r?.schema !== 'aiterm.agent-auth-result.v1' || r.harness !== 'claude-code'
      || !['waiting', 'authenticated', 'blocked', 'failed'].includes(r.status)) throw stop('invalid_receipt', 'unknown')
    if (action === 'cleanup') {
      if (r.session_id !== null || r.status !== 'blocked') throw stop('invalid_cleanup', 'unknown')
      return
    }
    if (r.session_id !== plan.sessionId) throw stop('wrong_session', 'unknown')
    const ui = authUi(r, plan.sessionId)
    if (!ui.binding || ui.stage === 'unavailable' || ui.binding.session_id !== plan.sessionId) throw stop('invalid_ui', 'unknown')
    const transition = r.binding_transition
    if (transition) {
      if (action === 'start' || transition.kind !== 'login_to_onboarding' || !equal(transition.from, state.binding)
        || !equal(transition.to, ui.binding)
        || Object.keys(state.binding).some(key => !['pane_pid', 'pane_started'].includes(key) && !equal(state.binding[key], ui.binding[key])))
        throw stop('invalid_transition', 'unknown')
      if (state.requestId) { state.requestBinding = structuredClone(ui.binding); state.requestDigest = null }
    } else if (state.binding && !equal(state.binding, ui.binding)) throw stop('stale_binding', 'unknown')
    if (ui.url !== null && !guideUrl(ui.url)) throw stop('invalid_origin', 'unknown')
    state.binding = structuredClone(ui.binding)
    state.digest = transition ? null : ui.prompt_digest
    state.stage = transition ? 'waiting' : ui.stage
    state.status = r.status
    state.url = ui.url
    if (transition && r.status !== 'waiting') throw stop('invalid_transition', 'unknown')
  }
  async function native(action, input) {
    const limits = { start: 1, status: 12, respond: 1, cleanup: 1 }
    if (state.counts[action] >= limits[action]) throw stop('budget_exhausted')
    if (action === 'status' && state.lastStatus !== null) await pause(Math.max(0, state.lastStatus + 5000 - Date.now()))
    await authorized(action === 'cleanup' ? 'cancel' : action)
    state.counts[action]++
    state.intent = action
    if (action === 'respond') state.consumed = true
    await record()
    // Recheck after fsync and before the effect; authorization failure never issues native input.
    await authorized(action === 'cleanup' ? 'cancel' : action)
    const payload = typeof input === 'function' ? await input() : input
    let result, gateFailure
    const assertBeforeIssue = () => {
      try { check() } catch (error) { gateFailure = error; throw error }
    }
    try { result = await bounded(Promise.resolve().then(() => {
      assertBeforeIssue()
      if (action === 'status') state.lastStatus = Date.now()
      return auth[action](payload, { assertBeforeIssue })
    }), deadline()) }
    catch (error) {
      if (gateFailure) throw gateFailure
      if (error instanceof Error && error.effect === 'not_issued'
        && ['AITERM_AUTH_CONNECTION_ARGUMENTS', 'AITERM_AUTH_CONNECTION_UNCONFIRMED', 'AITERM_AUTH_CAPABILITY_UNCONFIRMED'].includes(error.code))
        throw stop('local_not_issued')
      throw stop('native_unconfirmed', 'unknown')
    }
    parse(result, action)
    state.intent = null
    await record()
  }
  async function submitted() {
    return new Promise((resolve, reject) => {
      let timer, unwatch = () => {}
      const done = (error, item) => { unwatch(); clearTimeout(timer); activeSignal.removeEventListener('abort', abort); error ? reject(error) : resolve(item) }
      const abort = () => done(stop('interrupted'))
      const inspect = () => {
        try {
          check()
          const item = secretRequests.get(state.requestId)
          if (item.botId !== plan.requesterBotId || item.toolId !== plan.toolId || item.roomId !== plan.roomId) throw stop('wrong_request')
          if (item.status === 'submitted') done(null, item)
          else if (item.status !== 'pending') done(stop('request_closed'))
        } catch { done(stop('request_unavailable')) }
      }
      unwatch = secretRequests.watch(inspect)
      timer = setTimeout(() => done(stop('expired')), Math.max(0, deadline() - Date.now()))
      activeSignal.addEventListener('abort', abort, { once: true })
      inspect()
    })
  }
  async function secretValue() {
    const item = secretRequests.get(state.requestId)
    if (typeof secretRequests.resolveValue === 'function') {
      if (item.id !== state.requestId || item.botId !== plan.requesterBotId || item.toolId !== plan.toolId
        || item.roomId !== plan.roomId || item.status !== 'submitted') throw stop('wrong_request')
      const value = await secretRequests.resolveValue(item.id)
      if (typeof value !== 'string' || !/^[!-~]{1,8192}$/u.test(value)) throw stop('invalid_secret')
      return value
    }
    const expected = join(secretRequests.toolsDirectory, plan.toolId, 'secrets', state.requestId)
    if (item.id !== state.requestId || item.botId !== plan.requesterBotId || item.toolId !== plan.toolId
      || item.roomId !== plan.roomId || item.status !== 'submitted' || item.path !== expected
      || !isAbsolute(expected) || await realpath(expected) !== expected) throw stop('wrong_request')
    const fd = await open(expected, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await fd.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid()
        || (stat.mode & 0o777) !== 0o600 || stat.size < 1 || stat.size > 8192) throw stop('invalid_secret_file')
      const bytes = Buffer.alloc(8193)
      try {
        const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0)
        if (bytesRead !== stat.size || bytesRead > 8192 || bytes.subarray(0, bytesRead).some(byte => byte < 33 || byte > 126)) throw stop('invalid_secret')
        return bytes.subarray(0, bytesRead).toString('ascii')
      } finally { bytes.fill(0) }
    } finally { await fd.close() }
  }
  return {
    async execute({ signal } = {}) {
      if (started || closed) return receipt('not_issued', 'already_closed')
      started = true
      const begunAt = Date.now()
      activeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
      let lockOwned = false
      try {
        check()
        await mkdir(runDirectory, { recursive: true, mode: 0o700 })
        if (await realpath(runDirectory) !== runDirectory) throw stop('invalid_directory')
        const directory = await open(runDirectory, constants.O_RDONLY)
        try {
          const stat = await directory.stat()
          if ((stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid()) throw stop('invalid_directory')
        } finally { await directory.close() }
        journal = await open(join(runDirectory, plan.runId + '.jsonl'), 'wx', 0o600)
        const lock = await open(lockPath, 'wx', 0o600)
        lockOwned = true
        try { await lock.writeFile(plan.runId); await lock.sync() } finally { await lock.close() }
        await syncDirectory(runDirectory)
        try {
          const reservation = await open(join(runDirectory, `session-${plan.sessionId}.reserved`), 'wx', 0o600)
          try { await reservation.writeFile(plan.runId); await reservation.sync() } finally { await reservation.close() }
          await syncDirectory(runDirectory)
        } catch (error) { throw stop(error?.code === 'EEXIST' ? 'session_reserved' : 'session_reservation_failed') }
        state = { runId: plan.runId, phase: 'running', startedAt: begunAt, deadline: begunAt + 900000,
          sessionId: plan.sessionId, requestId: null, binding: null, digest: null, stage: null, status: null, url: null,
          counts: { start: 0, status: 0, respond: 0, cleanup: 0 }, lastStatus: null, intent: null, consumed: false }
        await record()
        await native('start')
        while (state.status !== 'authenticated') {
          if (state.stage === 'select') throw stop('intervention_required')
          if (state.stage === 'failed' || ['failed', 'blocked'].includes(state.status)) throw stop('native_failed')
          if (!state.requestId && state.url) {
            await authorized('respond')
            state.inputDeadline = Math.min(Date.now() + 600000, deadline())
            state.requestBinding = structuredClone(state.binding)
            state.requestDigest = state.digest
            state.requestUrl = state.url
            const request = await bounded(secretRequests.create({ botId: plan.requesterBotId, roomId: plan.roomId, toolId: plan.toolId,
              label: 'Claude認証コード', message: 'この専用カードの公式ログイン画面で認証し、表示されたコードを入力してください。通常チャットへは書かないでください。' }), deadline())
            if (typeof request.id !== 'string' || !/^[a-f0-9-]{1,64}$/u.test(request.id)) throw stop('invalid_request')
            state.requestId = request.id
            state.phase = 'awaiting_secret'
            await record()
            guideReady = true
            secretRequests.notifyOwnerGuide(state.requestId)
            await submitted()
            state.phase = 'running'
            await record()
            await native('status', { binding: structuredClone(state.binding) })
          }
          if (state.requestId && state.stage === 'paste_code' && state.digest && !state.consumed) {
            if (!equal(state.binding, state.requestBinding) || state.url !== state.requestUrl
              || state.requestDigest !== null && state.digest !== state.requestDigest) throw stop('stale_prompt')
            await native('respond', async () => ({ binding: structuredClone(state.binding), prompt_digest: state.digest,
              response: { kind: 'authorization_code', value: await secretValue() } }))
          } else if (state.status !== 'authenticated') await native('status', { binding: structuredClone(state.binding) })
        }
        await native('cleanup', { binding: structuredClone(state.binding) })
        state.phase = 'complete'; state.url = null
        await record()
        await unlink(lockPath)
        await syncDirectory(runDirectory)
        return receipt('confirmed', 'authenticated_and_closed')
      } catch (error) {
        const outcome = !lockOwned ? 'not_issued' : error[stopped] ? error.outcome : 'unknown'
        const reason = error[stopped] ? error.reason : 'operation_unconfirmed'
        if (state) {
          state.phase = outcome; state.url = null; state.reason = reason
          try { await record() } catch { return receipt('unknown', 'persistence_unconfirmed') }
        }
        return receipt(outcome, lockOwned ? reason : 'not_admitted')
      } finally { if (journal) await journal.close().catch(() => {}) }
    },
    close() { closed = true; controller.abort() },
    async ownerSecretGuide({ requestId, botId, roomId }) {
      try {
        if (!guideReady || !state || state.phase !== 'awaiting_secret' || requestId !== state.requestId || botId !== plan.requesterBotId
          || roomId !== plan.roomId || !guideUrl(state.url)) return null
        check()
        const item = secretRequests.get(requestId)
        if (item.id !== requestId || item.status !== 'pending' || item.botId !== botId || item.roomId !== roomId || item.toolId !== plan.toolId) return null
        await authorized('respond')
        if (state.phase !== 'awaiting_secret' || secretRequests.get(requestId).status !== 'pending') return null
        return { url: state.url }
      } catch { return null }
    },
  }
}
