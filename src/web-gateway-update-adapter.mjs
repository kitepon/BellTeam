const fail = code => { throw Object.assign(new Error(code), { code, status: 503 }) }
const source = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)

export function createWebGatewayUpdateAdapter({ gateway, builtinSourceCommit = null, prepare }) {
  const builtin = source(builtinSourceCommit) ? builtinSourceCommit : null
  const sameBuiltin = target => builtin !== null && target?.origin === 'builtin'
    && target.version === builtin && target.sourceCommit === builtin && target.digest === null
  const current = () => {
    const id = gateway()?.versionId
    if (id === null && builtin) return { version: builtin, digest: null, sourceCommit: builtin, origin: 'builtin' }
    return typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)
      ? { version: id, digest: `sha256:${id}`, sourceCommit: null, origin: 'release' } : null
  }
  return {
    current,
    capture: () => ({ generation: null, pid: gateway()?.pid ?? null }),
    available: () => Boolean(gateway()?.pid),
    canRollback: target => target?.origin === 'release' || sameBuiltin(target),
    async prepare(step) {
      if (step.target.origin === 'builtin') {
        if (!sameBuiltin(step.target)) fail('UPDATE_ROLLBACK_UNAVAILABLE')
        return
      }
      if (typeof prepare !== 'function') fail('UPDATE_EXECUTOR_UNAVAILABLE')
      const descriptor = await prepare(step.target.version, { expectedRelease: step.release })
      if (descriptor?.versionId !== step.target.version
        || step.target.sourceCommit !== null && descriptor.sourceCommit !== step.target.sourceCommit) fail('UPDATE_TARGET_CHANGED')
      if (step.release && (descriptor.protocolVersion !== 1
        || descriptor.platform?.os !== step.release.platform.os
        || descriptor.platform?.arch !== step.release.platform.arch)) fail('UPDATE_INCOMPATIBLE')
    },
    async apply(step) {
      if (step.target.origin === 'builtin' && !sameBuiltin(step.target)) fail('UPDATE_ROLLBACK_UNAVAILABLE')
      return gateway().replace(step.target.origin === 'builtin' ? 'builtin' : step.target.version)
    },
  }
}
