import { usageError, usageMethods, validateUsageActor } from './process-schema.mjs'

// Only authenticated parent ingress calls capture; nothing serializable is an authority.
export function createUsageAuthority() {
  const grants = new WeakMap()
  return {
    capture(method, actor) {
      if (!Object.hasOwn(usageMethods, method) || !validateUsageActor(actor)
        || !usageMethods[method].actors.includes(actor.kind)) throw usageError('USAGE_ACTOR_FORBIDDEN', 403)
      const token = Object.freeze({})
      grants.set(token, { method, actor: { ...actor } })
      return token
    },
    authorizeActor(method, token) {
      const grant = token && grants.get(token)
      if (!grant || grant.method !== method) throw usageError('USAGE_ACTOR_FORBIDDEN', 403)
      return { ...grant.actor }
    },
    release(token) { if (token) grants.delete(token) },
  }
}
