// Body side of the approval-box-extension child's effects (runtime/approval-box-extension-child.md, data-flow rows 3-7).
// Ports are injected; the child never gets the facade or the credential store, only these fixed methods.
export const APPROVAL_BOX_SESSION_SCOPE = Object.freeze({ terminalId: 'approval-box-extension', purpose: 'approval-box.session' })
const fail = (code, status) => Object.assign(new Error(code), { code, status })
const unavailable = () => fail('APPROVAL_BOX_EXTENSION_SESSION_UNAVAILABLE', 503)
const text = value => value == null ? '' : String(value)

export function createApprovalBoxExtensionEffects({ lattice, bots, credentials = null, scope = APPROVAL_BOX_SESSION_SCOPE, daemon = null }) {
  return async (method, params) => {
    switch (method) {
      // A refused Owner-task write is told apart so the child skips that decision; every other failure ends the tick (the child's retry).
      case 'lattice.ownerTask': return lattice.ownerTask({ projectId: params.projectId, args: params.args, input: params.input ?? null })
        .catch(error => { throw error?.code === 'LATTICE_OWNER_TASK_REFUSED' ? fail('APPROVALS_EFFECT_REFUSED', 409) : error })
      case 'lattice.link': return lattice.link({ projectId: params.projectId, plan: params.plan, taskId: params.taskId })
      // The facade returns the full snapshot and {schema, at, charts}; the child's protocol takes only the narrowed shapes (the validator refuses extra keys).
      case 'lattice.chart': { const { cards, edges } = await lattice.chart(params.projectId); return { cards, edges } }
      case 'lattice.charts': return (await lattice.charts()).charts.map(chart => ({ projectId: chart.projectId, name: chart.name ?? null, createdBy: chart.createdBy ?? null, coordinator: chart.coordinator === true }))
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
      // a490g: the hosted daemon (a490h) holds what BellTeam's seats and the body filed; read only. Not paired / not running = nothing to read, never an error that stops the tick.
      case 'daemon.decisions.list': {
        if (!daemon?.route) return []
        const listed = await daemon.route('GET', '/decisions').catch(() => null)
        return (Array.isArray(listed?.items) ? listed.items : []).map(item => ({ id: text(item.decision_id ?? item.id) })).filter(item => /^K-[A-Z0-9]{4,16}$/u.test(item.id)).slice(0, 500)
      }
      case 'daemon.decisions.read': {
        if (!daemon?.route) return null
        const rec = await daemon.route('GET', `/decisions/${encodeURIComponent(params.id)}`).catch(error => { if (error?.status === 404 || error?.status === 503) return null; throw error })
        if (!rec) return null
        const answer = rec.answer && typeof rec.answer === 'object' ? { optionId: rec.answer.option_id ?? null, text: rec.answer.text ?? null, answeredAt: rec.answer.answered_at ?? null } : null
        return { id: text(rec.decision_id ?? rec.id), title: text(rec.title), status: text(rec.status), version: rec.version, urgency: text(rec.urgency), sessionLabel: text(rec.session_label),
          requester: rec.requester == null ? null : text(rec.requester), cancelReason: rec.cancel_reason == null ? null : text(rec.cancel_reason), createdAt: text(rec.created_at), updatedAt: text(rec.updated_at),
          options: (rec.options ?? []).map(option => ({ id: text(option.id), label: text(option.label) })), answer,
          ...(rec.recommendation ? { recommendation: text(rec.recommendation) } : {}), ...(rec.deadline ? { deadline: text(rec.deadline) } : {}) }
      }
      default: throw fail('APPROVAL_BOX_EXTENSION_EFFECT_INVALID', 400)
    }
  }
}
