import { open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BellTeamMessenger } from './messenger.mjs'
import { memberIdentity } from './member-identity.mjs'
import { returnedExecutionError } from './execution-error.mjs'
import { readImageBytes } from './message-assets.mjs'

const fail = code => { throw Object.assign(new Error(code), { code }) }

// One parent instance owns this log; child writers use its registered append effect.
export class DurableMessageReceipts extends BellTeamMessenger {
  constructor({ root, dispatch, onPending = () => {}, onError = error => console.error(error), ...options }) {
    super({ ...options, logPath: options.logPath ?? join(root, 'logs/direct-messages.jsonl'),
      onMessage: record => { if (!this.childRecords.has(record)) this.report(() => options.onMessage?.(record)) } })
    if (typeof dispatch !== 'function') fail('SAVED_DISPATCH_REQUIRED')
    this.dispatch = dispatch
    this.onPending = onPending
    this.onError = onError
    this.claims = new Map()
    this.lanes = new Map()
    this.executionSources = new Map()
    this.childRecords = new WeakSet()
  }

  async appendFromChild(record) {
    this.childRecords.add(record)
    try { await this.append(record) } finally { this.childRecords.delete(record) }
  }

  report(operation) {
    const report = error => {
      try { Promise.resolve(this.onError(error)).catch(failure => console.error(failure)) }
      catch (failure) { console.error(failure) }
    }
    try { Promise.resolve(operation()).catch(report) }
    catch (error) { report(error) }
  }

  async receive(input, { membersLease } = {}) {
    const allowed = ['from', 'target', 'message', 'image', 'images', 'executionSource']
    if (!input || Object.keys(input).some(key => !allowed.includes(key))) fail('MESSAGE_INPUT_INVALID')
    const { from, target, message, images = input.image ? [input.image] : [] } = input
    await this.bots.refresh?.(membersLease === undefined ? undefined : { membersLease })
    if (!['user', 'scheduler'].includes(from) && !this.bots.has(from)) fail('SENDER_NOT_FOUND')
    if (target === 'user' && from === 'user') fail('USER_TO_USER_NOT_ALLOWED')
    if (target !== 'user' && !this.bots.has(target)) fail('BOT_NOT_FOUND')
    if (typeof message !== 'string' || !Array.isArray(images) || (!message.length && !images.length)) fail('MESSAGE_REQUIRED')
    if (target !== 'user') await this.requireAccess({ from, target })
    const deliveryId = this.deliveryId()
    if (images.length && !this.assets) fail('IMAGE_STORAGE_REQUIRED')
    const imageAssets = images.length ? await this.assets.saveAll({ owner: from, id: deliveryId, images }) : []
    const record = { ...this.record({ deliveryId, from, target, message, images, imageAssets,
      delivery: target === 'user' ? 'delivered' : 'queued' }), durable_receipt: true }
    if (input.executionSource) this.executionSources.set(deliveryId, input.executionSource)
    try { return await this.saveReceipt(record) }
    catch (error) { this.executionSources.delete(deliveryId); throw error }
  }

  async saveReceipt(record) {
    for (const asset of record.image_assets ?? []) {
      const file = await open(join(this.assets.directory(asset.owner), asset.file), 'r')
      try { await file.sync() } finally { await file.close() }
      const directory = await open(this.assets.directory(asset.owner), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
    await this.append(record)
    // fsync of the containing directory also commits a newly created log name.
    const directory = await open(dirname(this.logPath), 'r')
    try { await directory.sync() } finally { await directory.close() }
    if (record.target !== 'user') this.report(() => this.onPending(record.delivery_id))
    return { delivery: record.delivery, delivery_id: record.delivery_id, from: record.from, target: record.target }
  }

  sendmessage(input, options) { return this.receive(input, options) }
  enqueueUserTurn(input, options) {
    if (input.recordUser === false) fail('UNRECORDED_TURN_REQUIRES_LEGACY_PORT')
    const { recordUser: _recordUser, ...message } = input
    return this.receive({ ...message, from: 'user' }, options)
  }

  async receiveCallBridge(input) {
    const { event, session_id: sessionId, target_id: target, source_system: sourceSystem, source_id: sourceId,
      source_label: sourceLabel, message, reply_required: replyRequired = true, seq = null } = input
    if (Object.keys(input).some(key => !['event', 'session_id', 'target_id', 'source_system', 'source_id', 'source_label', 'message', 'reply_required', 'seq'].includes(key))
      || !['session.message', 'session.reply'].includes(event)
      || [sessionId, target, sourceSystem, sourceId, sourceLabel].some(value => typeof value !== 'string' || !value)
      || typeof message !== 'string' || !message || typeof replyRequired !== 'boolean'
      || seq !== null && !Number.isFinite(seq)) fail('CALL_MESSAGE_INVALID')
    await this.bots.refresh?.()
    if (!this.bots.has(target)) fail('BOT_NOT_FOUND')
    const from = `call-bridge:${sourceSystem}:${sourceId}`
    await this.requireAccess({ from, target })
    return this.saveReceipt({ schema: 'bellteam.direct-message.v1', delivery_id: this.deliveryId(), at: this.now(),
      from, target, from_identity: { id: from, name: sourceLabel, position: sourceSystem, role: '通話相手' },
      target_identity: memberIdentity(this.bots, target), message, image: false, delivery: 'queued', durable_receipt: true,
      session_id: sessionId, call_event: event, call_seq: seq, call_reply_required: replyRequired })
  }

  async pending() {
    return (await this.store.durableReceipts()).filter(record => record.delivery === 'queued')
  }

  dispatchSaved(deliveryId) {
    if (typeof deliveryId !== 'string' || !deliveryId) return Promise.reject(new Error('DELIVERY_ID_REQUIRED'))
    if (this.claims.has(deliveryId)) return this.claims.get(deliveryId)
    const attempt = this.runSaved(deliveryId)
    this.claims.set(deliveryId, attempt)
    const clear = () => this.claims.delete(deliveryId)
    attempt.then(clear, clear)
    return attempt
  }

  async runSaved(deliveryId) {
    const durable = await this.store.durableReceipts()
    const records = await this.store.records()
    const matches = durable.filter(record => record.delivery_id === deliveryId)
    const originals = records.filter(record => record.delivery_id === deliveryId)
    if (originals.length !== 1) fail('DURABLE_RECEIPT_NOT_FOUND')
    if (matches.length !== 1 || matches[0].durable_receipt !== true) fail('DURABLE_RECEIPT_NOT_FOUND')
    const record = matches[0]
    if (record.delivery !== 'queued') return { delivery_id: deliveryId, delivery: record.delivery, dispatched: false }
    await this.appendDeliveryStatus(deliveryId, 'dispatching')
    let observed = false
    const callbacks = this.notificationCallbacks(record.target, deliveryId, record.session_id ? 'call' : 'direct')
    const knownReplyIds = new Set(records.filter(row => row.from === record.target && row.target === 'user').map(row => row.delivery_id))
    const prepared = { target: record.target, deliveryId, startedAt: this.now(), knownReplyIds }
    let result
    try {
      const options = {
        record,
        ...(this.executionSources.has(deliveryId) ? { executionSource: this.executionSources.get(deliveryId) } : {}),
        // Saved assets are private to UID1001; execution creates its own seat-readable temporary copy.
        images: await Promise.all((record.image_assets ?? []).map(async asset => ({ mime: asset.mime,
          data: (await readImageBytes({ path: join(this.assets.directory(asset.owner), asset.file) }, this.assets.maxBytes)).toString('base64') }))),
        queue: { context: 'direct', contextId: record.target, groupId: deliveryId, from: record.from,
          fromName: record.from_identity?.name ?? record.from, target: record.target, message: record.message,
          ...(record.session_id ? { call: { sessionId: record.session_id, event: record.call_event, seq: record.call_seq } } : {}) },
        callbacks: { ...callbacks,
          onStatus: (status, error, tracking) => {
            observed ||= ['running', 'steered', 'delivered'].includes(status) || tracking?.admission === 'accepted'
            if (!['running', 'steered', 'delivered', 'failed', 'stopped'].includes(status)) fail('DISPATCH_STATUS_INVALID')
            return callbacks.onStatus(status, error, tracking)
          },
          onUserComplete: reply => this.finishUserTurn(prepared, reply),
        },
      }
      result = await this.dispatch(options)
      if (!['running', 'steered', 'delivered'].includes(result?.delivery)) fail('DISPATCH_RESULT_INVALID')
    } catch (error) {
      const latest = (await this.store.durableReceipts()).find(row => row.delivery_id === deliveryId)
      const saved = latest?.delivery
      // A saved failed status stays failed only when Aiterm's typed frame proves the input never started, so the
      // history shows undelivered; an unproven failure after invocation stays unknown and is never replayed.
      const executionError = returnedExecutionError(error?.executionError)
      const staleTerminal = !observed && saved === 'failed' && executionError?.code === 'EXECUTION_STALE_GENERATION'
        && executionError.effect === 'not_started'
      const unsent = saved === 'failed' && executionError?.effect === 'not_started'
      const delivery = staleTerminal ? 'queued' : !observed && error?.effect === 'not_started' ? 'queued'
        : unsent || (observed && saved !== 'dispatching') ? saved : 'unknown'
      if (latest?.delivery !== delivery) await this.appendDeliveryStatus(deliveryId, delivery)
      if (staleTerminal) this.report(() => this.onPending(deliveryId))
      if (delivery !== 'queued') this.executionSources.delete(deliveryId)
      return { delivery_id: deliveryId, delivery, dispatched: false }
    }
    // A synchronous completion callback may already have saved a terminal status.
    const latest = (await this.store.records()).find(row => row.delivery_id === deliveryId)
    if (latest.delivery === 'dispatching') await this.appendDeliveryStatus(deliveryId, result.delivery)
    this.executionSources.delete(deliveryId)
    return { delivery_id: deliveryId, delivery: result.delivery, dispatched: true }
  }

  // One lane per target: a seat's slow or failing acceptance never delays another target's saved input.
  // Inside a lane the saved order holds and each ID is attempted once; the lane keeps draining its target
  // until nothing new is queued, so a record saved meanwhile joins it instead of waiting for a new drain.
  drainTarget(target) {
    const running = this.lanes.get(target)
    // A record saved while the lane was ending is drained by a fresh lane after it, never left queued.
    if (running) return running.then(() => this.drainTarget(target), () => this.drainTarget(target))
    const seen = new Set(), results = []
    const next = async () => (await this.pending()).find(record => record.target === target && !seen.has(record.delivery_id))
    const lane = (async () => {
      for (let record = await next(); record; record = await next()) { seen.add(record.delivery_id); results.push(await this.dispatchSaved(record.delivery_id)) }
      return results
    })()
    this.lanes.set(target, lane)
    return lane.finally(() => this.lanes.delete(target))
  }

  async drain() {
    const targets = new Set((await this.pending()).map(record => record.target))
    return (await Promise.all([...targets].map(target => this.drainTarget(target)))).flat()
  }
}
