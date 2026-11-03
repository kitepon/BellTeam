// Ordinary assembly fixtures retain the real usage facade without starting the UID1001 entry.
export function createSyntheticNotificationsProcess({ onState }) {
  let currentVersionId = null, update = null
  let status = { configured: false, environments: [] }
  const snapshot = () => ({ currentVersionId, available: true, status, applyError: null, phase: 'running', update })
  const publishState = () => onState({ ...snapshot(), exchanging: false })
  return {
    async start() { publishState(); return snapshot() },
    async close() {},
    async request(method) {
      if (method === 'register' || method === 'unregister') return { registered: method === 'register' }
      if (method === 'publish') return { accepted: true }
      return status
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
