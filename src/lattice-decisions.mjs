// Body side of the Lattice effects decisions.file / read / cancel (lattice README L18-L19): a thin adapter over P1, the 決裁箱拡張 module's decision port
// (`approvals.decisions`, src/approval-box-client.mjs). It holds no token, secret card or connector. `port` is a getter: the approvals facade is built after the Lattice one.
// P1 errors carry `kind`; the child tells them apart by code (UNAVAILABLE ends the tick, REFUSED skips one card, GONE drops the record). No port, or any other failure, is UNAVAILABLE.
const CODES = { UNAVAILABLE: ['LATTICE_DECISIONS_UNAVAILABLE', 503], REFUSED: ['LATTICE_DECISIONS_REFUSED', 409], GONE: ['LATTICE_DECISIONS_GONE', 404] }

export function createLatticeDecisions({ port }) {
  const run = async (call, gone = 'GONE') => {
    try { return await call(port()) } catch (error) {
      const [code, status] = CODES[error?.kind === 'GONE' ? gone : error?.kind] ?? CODES.UNAVAILABLE
      throw Object.assign(new Error(code), { code, status })
    }
  }
  return {
    file: params => run(decisions => decisions.file({ ...params, origin: 'lattice' }), 'REFUSED'),
    read: ({ decisionId }) => run(decisions => decisions.read(decisionId)),
    // A cancel of an id the Approval Box no longer knows has always been REFUSED here (the request is already over).
    cancel: ({ decisionId, reason }) => run(decisions => decisions.cancel(decisionId, reason), 'REFUSED'),
  }
}
