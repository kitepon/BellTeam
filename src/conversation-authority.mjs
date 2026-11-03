import { assertConversationRootAuthority } from './conversation/authority.mjs'

// The authenticated parent ingress owns this factory; tokens never enter JSON.
export function createConversationAuthority() {
  const permissions = new WeakMap()
  return {
    capture(method, actor) {
      assertConversationRootAuthority(method, actor)
      const capturedAuthority = Object.freeze({})
      permissions.set(capturedAuthority, { method, actor: Object.freeze({ ...actor }) })
      return capturedAuthority
    },
    authorizeActor(method, capturedAuthority) {
      const permission = capturedAuthority && typeof capturedAuthority === 'object'
        ? permissions.get(capturedAuthority) : null
      return permission && permission.method === method ? permission.actor : false
    },
    release(capturedAuthority) { permissions.delete(capturedAuthority) },
  }
}
