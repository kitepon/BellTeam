// Body side of the approval-box-extension child's effects (runtime/approval-box-extension-child.md, data-flow rows 3-7).
// Ports are injected; the child never gets the facade or the credential store, only these fixed methods.
export const APPROVAL_BOX_SESSION_SCOPE = Object.freeze({ terminalId: 'approval-box-extension', purpose: 'approval-box.session' })
const fail = (code, status) => Object.assign(new Error(code), { code, status })
const unavailable = () => fail('APPROVAL_BOX_EXTENSION_SESSION_UNAVAILABLE', 503)
const text = value => value == null ? '' : String(value)

export function createApprovalBoxExtensionEffects({ lattice, bots, credentials = null, scope = APPROVAL_BOX_SESSION_SCOPE }) {
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
        return credentials.withResolved(current.handle, { ...scope, memberId: null }, value => ({ value }))
      }
      case 'session.put':
        // shortcut: put/erase are Mika's system-only usage methods (R7); until they land the port is absent and the effect answers unavailable.
        if (typeof credentials?.put !== 'function') throw unavailable()
        await credentials.put(scope, params.value)
        return { ok: true }
      case 'session.erase':
        if (typeof credentials?.erase !== 'function') throw unavailable()
        await credentials.erase(scope)
        return { ok: true }
      default: throw fail('APPROVAL_BOX_EXTENSION_EFFECT_INVALID', 400)
    }
  }
}
