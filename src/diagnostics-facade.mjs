// Keep the public object stable while the controller replaces its writer generation.
export function createDiagnosticsFacade(controller) {
  const optional = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
  return {
    initialize: () => controller.start(),
    record: report => controller.request('record', { report }),
    list: (status = 'all', limit = 500) => controller.request('list', { status, limit }),
    setStatus: (fingerprint, status, { note } = {}) => controller.request('setStatus', optional({ fingerprint, status, note })),
    setNote: (fingerprint, note) => controller.request('setNote', { fingerprint, note }),
    updateInvestigation: (fingerprint, { status, note } = {}) => controller.request('updateInvestigation', optional({ fingerprint, status, note })),
  }
}
