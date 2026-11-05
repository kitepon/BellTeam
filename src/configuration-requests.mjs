import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { configurationCapability, configurationConnection, configurationSettings, configurationDigest, configurationBinding,
  configurationReceipt, configurationError, configurationWasNotIssued, configurationIntentWasNotWritten, captureConfigurationRequest, CONFIGURATION_VERSION } from './configuration-request.mjs'

// New requests only. Existing IDs are read through reconcile, never applied again.
export class ConfigurationRequests {
  constructor({ client, intents }) {
    this.client = client
    this.intents = intents
    this.pending = new Map()
    this.active = new Set()
    this.latest = new Map()
    this.rejectedPreparations = new Map()
    this.unboundHandoffs = new Map()
  }

  async restore() {
    if (!this.restoring) this.restoring = (async () => {
      for (const original of await this.intents.pending()) {
        this.pending.set(original.botId, original); this.latest.set(original.botId, { intent: original, receipt: null })
      }
    })()
    await this.restoring
    return [...this.pending.values()].map(value => structuredClone(value))
  }

  view(botId) {
    const value = this.latest.get(botId)
    return value ? structuredClone({ binding: value.intent.binding, requested: value.intent.requested, receipt: value.receipt, receipt_persisted: value.persisted === true,
      ...(value.preparation ? { preparation: value.preparation } : {}), ...(value.localNotIssued ? { local_not_issued: true } : {}) }) : null
  }

  async prepare(botId, sessionId, settings, id = randomUUID()) {
    await this.restore()
    const unbound = this.unboundHandoffs.get(botId)
    const reusable = unbound?.binding.id === id && this.pending.get(botId) === unbound ? unbound : null
    if (this.active.has(botId) || this.pending.has(botId) && !reusable) throw configurationError('CONFIGURATION_REQUEST_PENDING')
    this.active.add(botId)
    this.unboundHandoffs.delete(botId)
    let original = reusable ?? undefined
    let published = Boolean(reusable)
    let publication = reusable ? 'confirmed' : 'not_started'
    try {
      const proposed = configurationSettings(settings)
      if (reusable && Object.keys(settings).some(key => proposed[key] !== reusable.requested[key]))
        throw configurationError('CONFIGURATION_SETTINGS_INVALID')
      const requested = reusable?.requested ?? proposed
      const connection = await configurationCapability(this.client)
      let listed
      try { listed = await connection.sdk.callTool({ name: 'pty_list', arguments: {} }) }
      catch (cause) { throw Object.assign(configurationError('CONFIGURATION_TARGET_UNCONFIRMED'), { cause }) }
      configurationConnection(this.client, connection.sdk, connection.transport)
      const data = listed?.structuredContent
      const rows = Array.isArray(data?.sessions) ? data.sessions.filter(value => value.session_id === sessionId) : null
      if (listed?.isError || data?.schema !== 'aiterm.pty-list-result.v1' || !Array.isArray(rows) || rows.length !== 1
        || typeof rows[0].launch_id !== 'string' || !/^[a-f0-9]{32}$/u.test(rows[0].launch_id)) throw configurationError('CONFIGURATION_TARGET_UNCONFIRMED')
      if (reusable && (reusable.binding.session_id !== sessionId || reusable.binding.launch_id !== rows[0].launch_id))
        throw configurationError('CONFIGURATION_TARGET_UNCONFIRMED')
      const binding = configurationBinding({ id, session_id: sessionId, launch_id: rows[0].launch_id, digest: configurationDigest(requested) })
      original = { schema: 'bellteam.configuration-intent.v1', botId, binding, requested, version: CONFIGURATION_VERSION }
      this.pending.set(botId, original)
      this.latest.set(botId, { intent: original, receipt: null })
      if (!reusable) publication = 'unknown'
      try { if (!reusable) await this.intents.publish(botId, original) }
      catch (cause) {
        if (configurationIntentWasNotWritten(cause)) publication = 'not_started'
        throw Object.assign(configurationError('CONFIGURATION_INTENT_SAVE_UNCONFIRMED'), { cause })
      }
      published = true
      publication = 'confirmed'
      configurationConnection(this.client, connection.sdk, connection.transport)
      const { session_id, ...request } = binding
      return { intent: structuredClone(original), connection,
        args: { action: 'apply', session_id, request, ...Object.fromEntries(Object.entries(requested).filter(([, value]) => value !== null)) } }
    } catch (error) {
      if (!original && error?.effect !== 'not_issued') error = Object.assign(configurationError('CONFIGURATION_CAPABILITY_UNCONFIRMED'), { cause: error })
      if (original) {
        const preparation = { state: 'not_returned', publication }
        this.rejectedPreparations.set(botId, { original, preparation })
        this.latest.get(botId).preparation = preparation
      }
      if (published && configurationWasNotIssued(error)) {
        try { await this.finishNotIssued(botId, original.binding) } catch { /* Retain the original intent and failure if its completion cannot be saved. */ }
      }
      if (original) captureConfigurationRequest(error, { binding: original.binding, requested: original.requested, receipt: null,
        receipt_persisted: false, preparation: this.latest.get(botId).preparation,
        ...(this.latest.get(botId)?.localNotIssued ? { local_not_issued: true } : {}) })
      throw error
    } finally { this.active.delete(botId) }
  }

  async prepareHandoff(botId, launch, settings, id = randomUUID()) {
    await this.restore()
    if (this.active.has(botId) || this.pending.has(botId)) throw configurationError('CONFIGURATION_REQUEST_PENDING')
    const requested = configurationSettings(settings)
    const binding = configurationBinding({ id, ...launch, digest: configurationDigest(requested) })
    const original = { schema: 'bellteam.configuration-intent.v1', botId, binding, requested, version: CONFIGURATION_VERSION }
    this.active.add(botId)
    try {
      this.pending.set(botId, original); this.latest.set(botId, { intent: original, receipt: null })
      await this.intents.publish(botId, original)
      this.unboundHandoffs.set(botId, original)
      return original
    } finally { this.active.delete(botId) }
  }

  claimHandoff(botId, binding) {
    if (!isDeepStrictEqual(this.unboundHandoffs.get(botId)?.binding, binding)) throw configurationError('CONFIGURATION_REQUEST_PENDING')
    this.unboundHandoffs.delete(botId)
  }

  canRecoverPreparation(botId, id) {
    const rejected = this.rejectedPreparations.get(botId)
    return rejected?.original.binding.id === id && this.pending.get(botId) === rejected.original
  }

  async recoverPreparation(botId, id) {
    if (!this.canRecoverPreparation(botId, id)) throw configurationError('CONFIGURATION_PREPARATION_UNCONFIRMED', 'possible')
    if (this.active.has(botId)) throw configurationError('CONFIGURATION_REQUEST_PENDING')
    const rejected = this.rejectedPreparations.get(botId)
    this.active.add(botId)
    try {
      await this.intents.recoverNotIssued(rejected.original)
      if (!this.canRecoverPreparation(botId, id)) throw configurationError('CONFIGURATION_PREPARATION_UNCONFIRMED', 'possible')
      this.pending.delete(botId)
      this.rejectedPreparations.delete(botId)
      this.latest.get(botId).localNotIssued = true
      return { schema: 'bellteam.configuration-local-completion.v1', binding: { ...rejected.original.binding },
        outcome: 'not_applied', effect: 'not_issued' }
    } finally { this.active.delete(botId) }
  }

  async finishNotIssued(botId, binding) {
    await this.intents.saveNotIssued(botId, binding)
    if (this.unboundHandoffs.get(botId)?.binding.id === binding.id) this.unboundHandoffs.delete(botId)
    if (this.pending.get(botId)?.binding.id === binding.id) this.pending.delete(botId)
    const value = this.latest.get(botId)
    if (value?.intent.binding.id === binding.id) value.localNotIssued = true
  }

  async record(botId, receipt, origin) {
    const latest = this.latest.get(botId)
    const same = latest?.intent.binding.id === receipt.binding.id
    const directApply = origin === 'apply' && receipt.request_state === 'terminal' && receipt.outcome === 'applied' ? receipt
      : same ? latest.directApply : null
    if (same) { latest.receipt = receipt; latest.persisted = false; latest.directApply = directApply }
    const equivalent = directApply && isDeepStrictEqual({ ...directApply, observed_at: null }, { ...receipt, observed_at: null })
    const saved = await this.intents.saveTerminal(botId, equivalent ? directApply : receipt, equivalent ? 'apply' : origin)
    const original = await this.intents.read(botId, receipt.binding.id)
    if (this.pending.has(botId) && this.pending.get(botId).binding.id !== receipt.binding.id) return
    this.latest.set(botId, { intent: original, receipt, persisted: Boolean(saved), directApply })
    if (receipt.request_state === 'terminal' && (saved?.origin === 'apply' && receipt.outcome === 'applied' || receipt.later_effect === 'excluded')) this.pending.delete(botId)
    else this.pending.set(botId, original)
  }

  async recordHandoff(botId, snapshot) {
    const saved = await this.intents.saveHandoffTerminal(botId, snapshot)
    if (this.pending.get(botId)?.binding.id === saved.operation.id) this.pending.delete(botId)
    return saved
  }

  async reconcile(botId, id) {
    const original = await this.intents.read(botId, id)
    if (await this.intents.notIssued(botId, original.binding)) throw Object.assign(configurationError('CONFIGURATION_REQUEST_NOT_ISSUED'), { status: 409 })
    const connection = await configurationCapability(this.client)
    const { session_id, ...request } = original.binding
    const result = await this.client.call('agent_configure', { action: 'reconcile', session_id, request }, { expectedConfiguration: connection })
    const receipt = configurationReceipt(result?.structuredContent, original.binding)
    await this.record(botId, receipt, 'reconcile')
    return receipt
  }
}
