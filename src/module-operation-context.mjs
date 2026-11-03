const rejected = () => Object.assign(new Error('MODULE_OPERATION_NOT_ACCEPTED'), {
  code: 'MODULE_OPERATION_NOT_ACCEPTED', status: 503, outcome: 'not_accepted', effect: 'not_started',
})

// Both enter calls are synchronous; no effect or slot wait runs between them.
export function createModuleOperationContext({ membersAdmission, conversationAdmission }) {
  const contexts = new WeakSet()
  const finished = new WeakSet()
  const byMembers = new WeakMap(), borrowed = new WeakSet()
  const assert = context => {
    if (!contexts.has(context)) throw rejected()
    membersAdmission.assertLease(context.membersLease)
    conversationAdmission.assertLease(context.conversationLease)
    return context
  }
  const reserve = (options = {}) => {
    const membersLease = options.membersLease ? membersAdmission.assertLease(options.membersLease) : membersAdmission.enter()
    let conversationLease
    try { conversationLease = conversationAdmission.enter() }
    catch (error) { if (!options.membersLease) membersAdmission.finish(membersLease); throw error }
    const context = Object.freeze({ membersLease, conversationLease })
    contexts.add(context)
    byMembers.set(membersLease, context)
    if (options.membersLease) borrowed.add(context)
    return context
  }
  const finish = context => {
    assert(context)
    if (finished.has(context)) throw rejected()
    finished.add(context)
    try { if (!borrowed.has(context)) membersAdmission.finish(context.membersLease) }
    finally { conversationAdmission.finish(context.conversationLease) }
  }
  const withContext = (operation, context) => {
    const owned = context === undefined
    const current = owned ? reserve() : assert(context)
    let result
    try { result = operation(current) }
    catch (error) { if (owned) finish(current); throw error }
    return Promise.resolve(result).finally(() => { if (owned) finish(current) })
  }
  return { reserve, assert, finish, withContext,
    forMembers(lease) { const value = byMembers.get(lease); try { return value ? assert(value) : null } catch { return null } },
  }
}
