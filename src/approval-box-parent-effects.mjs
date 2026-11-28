// Body side of the approval-box-extension child's effects (runtime/approval-box-extension-child.md, data-flow rows 3-7).
// Ports are injected; the child never gets the facade or the credential store, only these fixed methods.
export const APPROVAL_BOX_SESSION_SCOPE = Object.freeze({ terminalId: 'approval-box-extension', purpose: 'approval-box.session' })
const fail = (code, status) => Object.assign(new Error(code), { code, status })
const unavailable = () => fail('APPROVAL_BOX_EXTENSION_SESSION_UNAVAILABLE', 503)
const text = value => value == null ? '' : String(value)

// Refusals that repeat whatever happens later (Bot deleted, bad text): the child records them instead of retrying forever (as lattice-facade.mjs does).
const PERMANENT = /^(SENDER_NOT_FOUND|BOT_NOT_FOUND|MESSAGE_REQUIRED)\b/u

// messenger + runAs: the public send path, the same one the sendmessage tool and Lattice's notices use (README section 13, F8). No messenger: the child retries on the next tick.
export function createApprovalBoxExtensionEffects({ lattice, bots, credentials = null, scope = APPROVAL_BOX_SESSION_SCOPE, decisions = null, messenger = null, runAs = (actor, send) => send() }) {
  const viaP1 = async (call, gone = null) => {
    const port = typeof decisions === 'function' ? decisions() : decisions
    if (!port) throw fail('APPROVAL_BOX_EXTENSION_DECISIONS_UNAVAILABLE', 503)
    try { return await call(port) } catch (error) {
      if (error?.kind === 'REFUSED') throw fail('APPROVALS_EFFECT_REFUSED', 409)
      if (error?.kind === 'GONE' && gone) return gone()
      throw fail('APPROVAL_BOX_EXTENSION_DECISIONS_UNAVAILABLE', 503)
    }
  }
  return async (method, params) => {
    switch (method) {
      // A refused Owner-task write is told apart so the child skips that decision; every other failure ends the tick (the child's retry).
      case 'lattice.ownerTask': return lattice.ownerTask({ projectId: params.projectId, args: params.args, input: params.input ?? null })
        .catch(error => { throw error?.code === 'LATTICE_OWNER_TASK_REFUSED' ? fail('APPROVALS_EFFECT_REFUSED', 409) : error })
      case 'lattice.link': return lattice.link({ projectId: params.projectId, plan: params.plan, taskId: params.taskId })
      // The facade returns the full snapshot and {schema, at, charts}; the child's protocol takes only the narrowed shapes (the validator refuses extra keys).
      case 'lattice.chart': { const { cards, edges } = await lattice.chart(params.projectId); return { cards, edges } }
      case 'lattice.charts': return (await lattice.charts()).charts.map(chart => ({ projectId: chart.projectId, name: chart.name ?? null, createdBy: chart.createdBy ?? null, coordinator: chart.coordinator === true }))
      case 'seat.message': {
        if (!messenger) throw unavailable()
        try {
          const value = await runAs({ kind: 'scheduler' }, () => messenger.sendmessage({ from: 'scheduler', target: params.target, message: params.message }))
          return { delivery: text(value?.delivery) || 'delivered', deliveryId: value?.delivery_id ?? null }
        } catch (error) {
          const code = PERMANENT.exec(error?.message ?? '')?.[1]
          if (code) return { delivery: 'refused', deliveryId: null, code }
          throw error
        }
      }
      case 'members.list': return (await bots.listForClient()).map(item => ({ id: text(item.id), name: text(item.name) }))
      case 'session.get': {
        if (!credentials) throw unavailable()
        const current = await credentials.current(scope)
        if (!current) return null
        if (!current.available) throw unavailable()
        // The value file is lost (usage SECRET_SOURCE_UNAVAILABLE): erase the stale handle and answer not connected, so a new connect is possible.
        return credentials.withResolved(current.handle, { ...scope, memberId: null }, value => ({ value }))
          .catch(async error => { if (error?.code !== 'SECRET_SOURCE_UNAVAILABLE') throw error; await credentials.erase(scope); return null })
      }
      case 'session.put':
        if (typeof credentials?.put !== 'function') throw unavailable()
        await credentials.put(scope, params.value)
        return { ok: true }
      case 'session.erase':
        if (typeof credentials?.erase !== 'function') throw unavailable()
        await credentials.erase(scope)
        return { ok: true }
      // F9 withdrawal (README section 5b): the module cancels only the machine-written requests it once filed, through P1 (decision-port.md, origin lattice).
      // REFUSED (already answered) reaches the child as APPROVALS_EFFECT_REFUSED; GONE (Approval Box no longer knows the id) as the result status 'gone'; P1 unavailable as a failed effect.
      case 'decisions.cancel': return viaP1(port => port.cancel(params.decisionId, params.reason), () => ({ status: 'gone' }))
      default: throw fail('APPROVAL_BOX_EXTENSION_EFFECT_INVALID', 400)
    }
  }
}
