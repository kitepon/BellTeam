// Ordinary assembly fixtures retain the real usage facade without starting the UID1001 entry.
export function createSyntheticNotificationsProcess({ onState }) {
  let currentVersionId = null, update = null
  const status = { apns: { configured: false, environments: [] }, webPush: { enabled: false, configured: false, publicKey: null, error: null } }
  const snapshot = () => ({ currentVersionId, available: true, status, applyError: { apns: null, webPush: null }, phase: 'running', update, protocolVersion: 2, stateSchema: 2 })
  const publishState = () => onState({ ...snapshot(), exchanging: false })
  return {
    async start() { publishState(); return snapshot() },
    async close() {},
    async request(method, params) {
      if (method === 'register' || method === 'unregister') return { registered: method === 'register' }
      if (method === 'publish') return { accepted: true }
      return status[params.provider]
    },
    snapshot,
    reserve(versionId) {
      update = { versionId, status: 'accepted' }
      return {
        start() { currentVersionId = versionId; update.status = 'succeeded'; publishState() },
        cancel() { update.status = 'not_started' },
      }
    },
  }
}
