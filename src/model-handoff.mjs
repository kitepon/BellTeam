import { createHash } from 'node:crypto'
import { isDeepStrictEqual as same } from 'node:util'
import { configurationSettings } from './configuration-request.mjs'
import { automaticConfigurationApplication } from './automatic-configuration-application.mjs'

const ingressKeys = 'actor,budget,expectedLaunch,nativeCall,originalMcpRequestId,schema,signal,toolName'
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys
const settings = bot => configurationSettings({ model: bot.model, reasoning_effort: bot.reasoningEffort, fast: bot.fastMode === true })
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const unavailable = () => Object.assign(new Error('AUTOMATIC_CONFIGURATION_UNAVAILABLE'), { code: 'AUTOMATIC_CONFIGURATION_UNAVAILABLE' })

export class ModelHandoff {
  constructor({ transport, requests, readAnchor, trackCompletion, records }) {
    Object.assign(this, { transport, requests, readAnchor, trackCompletion, records })
    this.operations = new Map()
  }

  eligible(botId, current, candidate, input) {
    return exact(input, ingressKeys) && input.schema === 'bellteam.mcp-configuration-ingress.v1'
      && exact(input.actor, 'botId,kind') && input.actor.kind === 'bot' && input.actor.botId === botId
      && input.toolName === 'update_self' && current.harness === 'codex' && candidate.harness === 'codex'
      && (typeof input.originalMcpRequestId === 'string' || Number.isSafeInteger(input.originalMcpRequestId))
      && input.signal instanceof AbortSignal && !input.signal.aborted && input.budget === null
      && typeof this.readAnchor === 'function'
  }

  async prepare({ botId, current, candidate, ingress, assertCurrent, requestId,
    deadline = performance.now() + 5000, windowSignal = ingress?.signal }) {
    if (!this.eligible(botId, current, candidate, ingress)) return null
    const connection = this.transport.client.captureHandoffConnection?.()
    if (!connection) return null
    const jobs = [...this.transport.jobs].filter(job => job.bot.id === botId && !job.stopped && !job.stopRequested
      && !job.nativeTerminal && !job.nativeUnconfirmed && job.receipt?.mode === 'agent_dispatch'
      && job.receipt.session_id === this.transport.session(current) && job.info.groupId
      && ['direct', 'room'].includes(job.info.context) && job.info.contextId
      && (job.info.context !== 'direct' || job.info.contextId === botId))
    if (jobs.length !== 1) return null
    const job = jobs[0], launch = { session_id: job.receipt.session_id, launch_id: job.receipt.launch_id }
    if (ingress.expectedLaunch !== null && !same(ingress.expectedLaunch, launch)) return null
    const abort = new AbortController()
    const cancel = () => abort.abort()
    ingress.signal.addEventListener('abort', cancel, { once: true })
    windowSignal?.addEventListener('abort', cancel, { once: true })
    if (ingress.signal.aborted || windowSignal?.aborted) cancel()
    const timer = setTimeout(cancel, Math.max(0, deadline - performance.now()))
    const check = () => {
      assertCurrent()
      if (abort.signal.aborted || performance.now() >= deadline || !connection.currentConnection()
        || !this.transport.jobs.has(job) || job.stopped || job.stopRequested || job.nativeTerminal || job.nativeUnconfirmed) throw unavailable()
    }
    const waitInWindow = value => new Promise((resolve, reject) => {
      const stop = () => { clear(); reject(unavailable()) }
      const clear = () => abort.signal.removeEventListener('abort', stop)
      abort.signal.addEventListener('abort', stop, { once: true })
      Promise.resolve(value).then(result => { clear(); resolve(result) }, error => { clear(); reject(error) })
      if (abort.signal.aborted) stop()
    })
    let original
    try {
      check()
      const capturing = connection.capture({ schema: 'aiterm.model-handoff.capture-request.v1', action: 'capture',
        launch, native_call: ingress.nativeCall, max_wait_ms: Math.max(1, Math.floor(deadline-performance.now())) }, abort.signal)
      this.trackCompletion(capturing)
      const captured = await waitInWindow(capturing)
      check()
      if (captured.status !== 'captured' || !same(captured.launch, launch) || !same(captured.native_call, ingress.nativeCall)
        || captured.point.boundary.event_cursor !== job.receipt.event_cursor
        || captured.anchor.client_delivery_id !== job.info.groupId) return null
      const anchor = { deliveryId: job.info.groupId, target: botId, context: job.info.context, contextId: job.info.contextId }
      const reading = this.readAnchor(anchor, { actor: ingress.actor, signal: abort.signal })
      this.trackCompletion(reading?.completion ?? reading)
      if (!same(await waitInWindow(reading), anchor)) return null
      check()
      original = await this.requests.prepareHandoff(botId, launch, settings(candidate), requestId)
      check()
      const call = captured.native_call, boundary = captured.point.boundary, birth = captured.process
      const tuple = ['bellteam.handoff-origin.v1', ingress.actor.botId, ingress.originalMcpRequestId,
        JSON.stringify([birth.harness.pid, birth.harness.start_identity, birth.backend.pid, birth.backend.start_identity]),
        JSON.stringify([anchor.deliveryId, anchor.target, anchor.context, anchor.contextId]),
        [launch.session_id, launch.launch_id, boundary.event_cursor, boundary.turn_id],
        [call.server_instance, call.thread_id, call.turn_id, call.call_id, call.source.kind,
          call.source.cell_id ?? null, call.source.runtime_call_id ?? null, call.call_token],
        [original.binding.id, launch.session_id, launch.launch_id, original.binding.digest]]
      const originBytes = Buffer.from(JSON.stringify(tuple), 'utf8')
      const context = { operation: original.binding, point: captured.point,
        origin_digest: createHash('sha256').update(originBytes).digest('hex'), native_call: call }
      return { original, context, connection, anchor, candidate, assertCurrent, assertOrigin: check, originBytes, captureSnapshot: captured,
        metadata: { operation: original.binding, origin_digest: context.origin_digest, call_token: call.call_token } }
    } catch {
      if (original) {
        try { assertCurrent() }
        catch { await this.requests.finishNotIssued(botId, original.binding).catch(() => {}) }
      }
      return null
    } finally {
      clearTimeout(timer); ingress.signal.removeEventListener('abort', cancel)
      windowSignal?.removeEventListener('abort', cancel)
    }
  }

  begin(prepared) {
    prepared.assertCurrent()
    prepared.assertOrigin?.()
    if (!prepared.connection.currentConnection()) throw unavailable()
    this.requests.claimHandoff(prepared.anchor.target, prepared.context.operation)
    let finish
    const operation = { ...prepared, contextDigest: digest(prepared.context), botId: prepared.anchor.target, phase: 'response', issued: false,
      sent: new Set(), snapshot: null, invalidated: false, completion: new Promise(resolve => { finish = resolve }), finish }
    operation.finish = finish
    this.operations.set(operation.context.operation.id, operation)
    let record = this.records.get(operation.botId)
    if (!record) this.records.set(operation.botId, record = { records: new Map() })
    record.currentRequestId = operation.context.operation.id
    this.updateProjection(operation)
    this.trackCompletion(operation.completion)
    // Binding must never become a prerequisite for returning the original tool response.
    void this.issue(operation, { action: 'bind', settings: operation.original.requested }).then(result => this.accept(operation, result)).catch(() => {})
    return operation
  }

  updateProjection(operation) {
    this.records.get(operation.botId).records.set(operation.context.operation.id, this.projection(operation))
  }

  async issue(operation, fields) {
    operation.issued ||= fields.action !== 'read'
    const issuing = operation.connection.control({ schema: 'aiterm.model-handoff.request.v1', context: operation.context, ...fields })
    this.trackCompletion(issuing)
    return issuing
  }

  async accept(operation, result) {
    if (result?.status !== 'recorded') { this.updateProjection(operation); return }
    const snapshot = result.snapshot
    const call = operation.context.native_call
    if (!same(snapshot.operation, operation.context.operation) || snapshot.context_digest !== operation.contextDigest
      || snapshot.server_instance !== call.server_instance || snapshot.thread_id !== call.thread_id || snapshot.turn_id !== call.turn_id
      || snapshot.resumed && (snapshot.resumed.delivery_id !== operation.anchor.deliveryId || snapshot.resumed.turn_id === call.turn_id)) throw unavailable()
    if (operation.snapshot && BigInt(snapshot.revision) < BigInt(operation.snapshot.revision)) return
    if (operation.snapshot && snapshot.revision === operation.snapshot.revision && !same(snapshot, operation.snapshot)) throw unavailable()
    operation.snapshot = snapshot
    this.updateProjection(operation)
    if (snapshot.later_effect === 'excluded' && snapshot.in_flight.length === 0) {
      const saved = await this.requests.recordHandoff(operation.botId, snapshot)
      operation.snapshot = saved; operation.finished = true; this.updateProjection(operation); operation.finish(saved)
    }
  }

  async read(operation) {
    await this.accept(operation, await this.issue(operation, { action: 'read' }))
    return this.projection(operation)
  }

  async poll() {
    await Promise.all([...this.operations.values()].filter(operation => !operation.reading
      && !operation.finished).map(async operation => {
      operation.reading = true
      try { await this.read(operation); await this.advance(operation) } catch { this.updateProjection(operation) }
      finally { operation.reading = false }
    }))
  }

  async advance(operation) {
    const snapshot = operation.snapshot
    if (!snapshot || operation.invalidated || snapshot.later_effect === 'excluded') return
    try { operation.assertCurrent() } catch { operation.invalidated = true; return }
    const stages = [['interrupt', snapshot.response.receipt], ['configure', snapshot.ended_receipt], ['resume', snapshot.configuration_receipt]]
    for (const [phase, receipt] of stages) {
      if (!receipt || snapshot.phases[phase].state !== 'not_started' || operation.sent.has(phase)) continue
      operation.assertCurrent()
      operation.sent.add(phase); operation.phase = phase; this.updateProjection(operation)
      const fields = { action: 'commit', phase, expected_receipt: receipt }
      if (phase === 'resume') fields.continuation = { delivery_id: operation.anchor.deliveryId,
        text: `設定を切り替えました。保存されたdocsと会話のdelivery_id=${operation.anchor.deliveryId}から未完了の仕事を確認して続けてください。実行済み又は結果不明の操作は繰り返さないでください。` }
      await this.accept(operation, await this.issue(operation, fields))
      return
    }
  }

  async revoke(operation, reason, supersedingRequestId = null) {
    operation.invalidated = true
    if (operation.finished) return
    operation.revocation = 'pending'; this.updateProjection(operation)
    try { await this.accept(operation, await this.issue(operation, {
      action: 'revoke', reason, superseding_request_id: supersedingRequestId })) }
    catch { operation.revocation = 'unknown'; this.updateProjection(operation) }
  }

  ownerStop(botId) {
    const operation = this.current(botId)
    if (!operation) return
    if (operation.stopping) return operation.stopping
    operation.invalidated = true; operation.stopIntent = 'accepted'; operation.admissionStopped = true
    this.updateProjection(operation)
    const stopping = (async () => {
      try { await this.requests.intents.saveHandoffStop(botId, operation.context.operation); operation.stopIntent = 'durable' }
      catch { operation.stopIntent = 'unknown' }
      this.updateProjection(operation)
      await this.revoke(operation, 'owner_stop')
    })()
    operation.stopping = stopping
    this.trackCompletion(stopping)
    return stopping
  }

  current(botId) {
    return [...this.operations.values()].find(operation => operation.botId === botId && !operation.finished) ?? null
  }

  assertAdmission(botId) {
    if (this.current(botId)?.admissionStopped) throw Object.assign(unavailable(), { effect: 'not_started' })
  }

  projection(operation) {
    const snapshot = operation.snapshot
    const observed = snapshot && Object.values(snapshot.phases).some(value => value.effect === 'observed')
    const excluded = snapshot?.later_effect === 'excluded' && snapshot.in_flight.length === 0
    return automaticConfigurationApplication({ schema: 'bellteam.automatic-configuration-application.v1',
      requestId: operation.context.operation.id, state: snapshot?.resumed ? 'completed' : excluded ? 'suppressed' : 'unknown',
      phase: operation.phase ?? 'response', effect: observed ? 'observed' : operation.issued ? 'possible' : 'not_started',
      laterEffect: excluded ? 'excluded' : 'unknown', stopIntent: operation.stopIntent ?? 'not_requested',
      admissionStopped: operation.admissionStopped === true,
      revocation: snapshot?.revocation === 'durable' ? 'confirmed' : operation.revocation ?? 'not_requested',
      errorCode: snapshot?.resumed ? null : excluded ? 'AUTOMATIC_CONFIGURATION_REVOKED' : 'AUTOMATIC_CONFIGURATION_UNKNOWN',
    })
  }
}
