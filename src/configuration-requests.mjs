import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { configurationSettings, configurationDigest, configurationBinding,
  configurationReceipt, configurationError, CONFIGURATION_VERSION } from './configuration-request.mjs'

// New requests only. Existing IDs are read through reconcile, never applied again.
export class ConfigurationRequests {
  constructor({ client, intents }) {
    this.client = client
    this.intents = intents
    this.pending = new Map()
    this.active = new Set()
    this.latest = new Map()
    this.unboundHandoffs = new Map()
  }

  view(botId) {
    const value = this.latest.get(botId)
    return value ? structuredClone({ binding: value.intent.binding, requested: value.intent.requested, receipt: value.receipt, receipt_persisted: value.persisted === true,
      ...(value.localNotIssued ? { local_not_issued: true } : {}) }) : null
  }

  async apply(botId, sessionId, launchId, settings, id = randomUUID()) {
    const requested = configurationSettings(settings)
    const binding = configurationBinding({ id, session_id: sessionId, launch_id: launchId, digest: configurationDigest(requested) })
    const intent = { schema: 'bellteam.configuration-intent.v1', botId, binding, requested, version: CONFIGURATION_VERSION }
    const latest = { intent, receipt: null, persisted: false }
    this.latest.set(botId, latest)
    let published = false
    try { await this.intents.publish(botId, intent); published = true }
    catch { this.auditWarning(botId, id) }
    const { session_id, ...request } = binding
    const result = await this.client.call('agent_configure', { action: 'apply', session_id, request,
      ...Object.fromEntries(Object.entries(requested).filter(([, value]) => value !== null)) })
    let receipt
    try { receipt = configurationReceipt(result?.structuredContent, binding) }
    catch { this.auditWarning(botId, id); return null }
    latest.receipt = receipt
    try { if (published) latest.persisted = Boolean(await this.intents.saveTerminal(botId, receipt, 'apply')) }
    catch { this.auditWarning(botId, id) }
    return receipt
  }

  auditWarning(botId, requestId) {
    try { process.stderr.write(JSON.stringify({ code: 'CONFIGURATION_AUDIT_UNAVAILABLE', botId, requestId }) + '\n') } catch {}
  }

  async prepareHandoff(botId, launch, settings, id = randomUUID()) {
    if (this.active.has(botId)) throw configurationError('CONFIGURATION_REQUEST_PENDING')
    const requested = configurationSettings(settings)
    const binding = configurationBinding({ id, ...launch, digest: configurationDigest(requested) })
    const original = { schema: 'bellteam.configuration-intent.v1', botId, binding, requested, version: CONFIGURATION_VERSION }
    this.active.add(botId)
    try {
      this.pending.set(botId, original); this.latest.set(botId, { intent: original, receipt: null })
      try { await this.intents.publish(botId, original) } catch { this.auditWarning(botId, binding.id) }
      this.unboundHandoffs.set(botId, original)
      return original
    } finally { this.active.delete(botId) }
  }

  claimHandoff(botId, binding) {
    if (!isDeepStrictEqual(this.unboundHandoffs.get(botId)?.binding, binding)) throw configurationError('CONFIGURATION_REQUEST_PENDING')
    this.unboundHandoffs.delete(botId)
  }

  async finishNotIssued(botId, binding) {
    try { await this.intents.saveNotIssued(botId, binding) } catch { this.auditWarning(botId, binding.id) }
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
    let saved = snapshot
    try { saved = await this.intents.saveHandoffTerminal(botId, snapshot) } catch { this.auditWarning(botId, snapshot.operation.id) }
    if (this.pending.get(botId)?.binding.id === saved.operation.id) this.pending.delete(botId)
    return saved
  }

  async reconcile(botId, id) {
    const original = await this.intents.read(botId, id)
    if (await this.intents.notIssued(botId, original.binding)) throw Object.assign(configurationError('CONFIGURATION_REQUEST_NOT_ISSUED'), { status: 409 })
    const { session_id, ...request } = original.binding
    const result = await this.client.call('agent_configure', { action: 'reconcile', session_id, request })
    const receipt = configurationReceipt(result?.structuredContent, original.binding)
    await this.record(botId, receipt, 'reconcile')
    return receipt
  }
}
