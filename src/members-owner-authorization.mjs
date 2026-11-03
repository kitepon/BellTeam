// Only the authenticated parent HTTP boundary can mint these method-bound objects.
export function createMembersOwnerAuthorization() {
  const requests = new WeakMap(), permissions = new WeakMap()
  const routes = new Map([['PATCH /api/owner', 'owner.update'], ['PUT /api/user-rules', 'rules.update']])
  return {
    captureHttp(request, pathname) {
      const method = routes.get(`${request.method} ${pathname}`)
      if (!method) return null
      const authorization = Object.freeze({})
      requests.set(request, authorization)
      permissions.set(authorization, method)
      return Object.freeze({ capturedAuthorization: authorization })
    },
    authorizeOwner(method, authorization) {
      return authorization !== null && typeof authorization === 'object'
        && permissions.has(authorization) && permissions.get(authorization) === method
    },
    releaseHttp(request) {
      const authorization = requests.get(request)
      if (authorization) permissions.delete(authorization)
      requests.delete(request)
    },
  }
}
