const categories = new Set(['capacity', 'rate_limited'])
const sameSettings = (a, b) => ['harness', 'model', 'reasoningEffort', 'fastMode'].every(key => a?.[key] === b?.[key])
const superseded = () => Object.assign(new Error('CONTINUATION_SUPERSEDED'), { code: 'CONTINUATION_SUPERSEDED', effect: 'not_started' })

// A bound terminal is permission to consider a new continuation, never to replay input.
export function recoverableTurnFailure(receipt, result) {
  const failure = result?.failure, boundary = failure?.boundary
  if (receipt?.mode !== 'agent_dispatch' || result?.schema !== 'aiterm.agent-wait-result.v1'
    || !['error', 'rate_limited'].includes(result.outcome) || !categories.has(failure?.category)
    || failure.terminal !== true || failure.future_effects !== 'unknown'
    || !['not_started', 'started', 'unknown'].includes(failure.execution) || !boundary
    || Object.keys(failure).sort().join(',') !== 'boundary,category,execution,future_effects,terminal'
    || result.session_id !== receipt.session_id || result.launch_id !== receipt.launch_id
    || !/^[a-f0-9]{32}$/u.test(receipt.launch_id ?? '') || result.vendor !== receipt.vendor
    || !Number.isSafeInteger(receipt.event_cursor) || boundary.event_cursor !== receipt.event_cursor
    || boundary.operation_id !== result.operation_id || boundary.turn_id !== result.turn_id) return null
  if (receipt.vendor === 'claude') {
    if (!/^[a-f0-9]{32}$/u.test(receipt.input_id ?? '') || result.input_id !== receipt.input_id || boundary.input_id !== receipt.input_id
      || Object.keys(boundary).sort().join(',') !== 'event_cursor,input_id,operation_id,turn_id') return null
  } else if (receipt.vendor === 'codex') {
    if (typeof result.turn_id !== 'string' || !result.turn_id || Object.keys(boundary).sort().join(',') !== 'event_cursor,operation_id,turn_id') return null
  } else return null
  return structuredClone({ category: failure.category, execution: failure.execution, terminal: true,
    future_effects: 'unknown', boundary, session_id: result.session_id, launch_id: result.launch_id })
}

export class CapacityContinuation {
  constructor({ bots, administration, messenger, models, harnessAuth, assertEnabled, accounts = null, transport = null }) {
    Object.assign(this, { bots, administration, messenger, models, harnessAuth, assertEnabled, accounts, transport })
    // shortcut: the finite episode budget is process-local, persist it if recovery must span restarts.
    this.states = new Map()
    this.pending = new Set()
    this.closed = false
  }

  failed(context) {
    if (this.closed || !(context.failure || context.accountLimit) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(context.deliveryId)) return
    let state = this.states.get(context.bot.id)
    if (state?.running) { state.next = context; return }
    if (!state || state.deliveryId !== context.deliveryId) {
      state = { attempted: new Set([context.bot.harness]), sent: 0, deliveryId: context.deliveryId }
      this.states.set(context.bot.id, state)
    }
    state.running = true
    const operation = this.continue(context, state).catch(() => {
      process.stderr.write(`BellTeam automatic continuation unconfirmed: ${context.bot.id}\n`)
    })
      .finally(() => {
        this.pending.delete(operation); state.running = false
        const next = state.next; state.next = null
        if (next) this.failed(next)
      })
    this.pending.add(operation)
  }

  succeeded(botId, deliveryId) {
    if (this.states.get(botId)?.deliveryId === deliveryId) this.states.delete(botId)
  }

  async continue(context, state) {
    if (state.sent >= 2) return
    const guard = message => {
      if (this.closed) throw superseded()
      this.assertEnabled()
      context.check(message)
    }
    guard()
    await this.bots.refresh?.()
    if (!sameSettings(this.bots.get(context.bot.id), context.bot)) throw superseded()
    // harness-accounts.md "account recovery": the transport moves the member now when a usable slot is free, or when one frees
    // (Aiterm's limit end keeps the cut turn durably). Another harness only with Aiterm's terminal proof and no free slot, as before.
    if (context.accountLimit && this.accounts && this.transport?.recoverAccount) {
      await context.accountLimit.recorded.catch(() => {})
      guard()
      if (!context.failure || await this.accounts.freeSlot('claude', context.bot.model)) {
        this.transport.recoverAccount(context.bot.id)
        return
      }
    }
    // Another harness only with Aiterm's terminal-failure proof; an account limit alone ends here.
    if (!context.failure) return
    for (const harness of ['codex', 'claude', 'grok', 'cursor', 'antigravity']) {
      if (state.attempted.has(harness)) continue
      state.attempted.add(harness)
      let catalogue
      try {
        if ((await this.harnessAuth.status(harness)).status !== 'authenticated') continue
        catalogue = await this.models.forHarness(harness)
      } catch { continue }
      guard()
      const choices = catalogue.models.filter(model => model.efforts.includes('high'))
      const selected = harness === 'codex'
        ? choices.filter(model => /-sol$/u.test(model.id)).sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))[0]
        : choices.find(model => model.id === catalogue.defaultModel) ?? choices[0]
      if (!selected) continue
      const changes = { harness, model: selected.id, reasoningEffort: 'high', fastMode: false }
      await this.administration.update(context.bot.id, changes, { waitForApplication: true, expected: context.bot, admissionCheck: () => guard() })
      const current = this.bots.get(context.bot.id)
      if (!sameSettings(current, changes)) throw superseded()
      context.reconfigured?.()
      guard()
      const message = '利用上限またはモデルの混雑で前の処理が終了したため、利用可能な別ハーネスへ切り替えました。' +
        `元の依頼は保存された会話履歴のdelivery_id=${context.deliveryId}です。` +
        '自分のdocs/と保存された会話・作業記録から未完了の仕事と元の目的を確認し、続けてください。' +
        '前の処理で実行済みの操作や結果不明の副作用を確認し、元の依頼本文や完了済みの操作を繰り返さないでください。'
      const check = () => {
        guard(message)
        if (!sameSettings(this.bots.get(context.bot.id), changes)) throw superseded()
        const application = this.administration.view(this.bots.get(context.bot.id)).configurationApplication
        if (application && application.state !== 'accepted') throw superseded()
      }
      check(); state.sent++
      const result = await this.messenger.sendmessage({ from: 'scheduler', target: context.bot.id, message }, { admissionCheck: check })
      state.deliveryId = result.delivery_id
      return
    }
  }

  // The account recovery's one message to a member whose limited turn moves to a free slot (harness-accounts.md).
  async resume(bot, { slot, deliveryId = null }) {
    const check = () => { if (this.closed) throw superseded(); this.assertEnabled() }
    check()
    const message = `利用上限かログイン切れで止まっていた前の処理を、同じAIの${slot}アカウントの席で続けてください。前の会話は短期記憶と手順書で引き継いでいます。` +
      (deliveryId ? `元の依頼は保存された会話履歴のdelivery_id=${deliveryId}です。` : '') +
      '前の処理で実行済みの操作や結果不明の副作用を確認し、元の依頼本文や完了済みの操作を繰り返さずに続けてください。'
    const result = await this.messenger.sendmessage({ from: 'scheduler', target: bot.id, message }, { admissionCheck: check })
    // A failure of this message continues the same chain (failed() matches its delivery id).
    const state = this.states.get(bot.id)
    if (state && result?.delivery_id) state.deliveryId = result.delivery_id
    return result
  }

  close() {
    this.closed = true
    return Promise.allSettled([...this.pending])
  }
}
