const failure = (code, status) => Object.assign(new Error(code), { code, status })

export function createWebGatewayControl({ gateway }) {
  let update = null, closed = false
  const snapshot = () => ({ currentVersionId: gateway()?.versionId ?? null, update: update ? { ...update } : null })
  const reserve = versionId => {
    if (typeof versionId !== 'string' || !/^[a-f0-9]{64}$/.test(versionId)) throw failure('WEB_GATEWAY_VERSION_INVALID', 400)
    if (closed || !gateway()) throw failure('WEB_GATEWAY_UNAVAILABLE', 503)
    if (update && ['accepted', 'running'].includes(update.status)) throw failure('WEB_GATEWAY_UPDATE_IN_PROGRESS', 409)
    const next = { versionId, status: 'accepted' }
    update = next
    let settled = false
    return {
      start() {
        if (settled) return
        settled = true
        if (closed) { next.status = 'not_started'; return }
        next.status = 'running'
        void Promise.resolve().then(() => {
          if (closed) { next.status = 'not_started'; return }
          return gateway().replace(versionId).then(() => { next.status = 'succeeded' })
        }).catch(error => {
          next.status = 'failed'
          next.error = /^GATEWAY_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'GATEWAY_UPDATE_FAILED'
        })
      },
      cancel() { if (!settled) { settled = true; next.status = 'not_started' } },
    }
  }
  const close = () => {
    closed = true
    if (update?.status === 'accepted') update.status = 'not_started'
  }
  return { snapshot, reserve, close }
}
