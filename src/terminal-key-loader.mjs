// Parent side of the terminal key loader (terminals' key-reader port, Crust). The key never reaches the parent: the 認証仲介 module runs
// /app/scripts/terminal-key-load as the seat uid with SSH_KEY in the loader's own environment; the parent keeps only exit code and the Aiterm DTO.
export const TERMINAL_KEY_LOADER = '/app/scripts/terminal-key-load'
// The registered Bot the module grants the three loader commands to (Sakura's grants name it; Tronie's ruling: the module runs the loader, the parent only starts it).
export const TERMINAL_KEY_OPERATOR = 'bot-09e6225c'
const failed = (code = 'TERMINAL_KEY_LOAD_UNAVAILABLE', status = 503, extra = {}) => Object.assign(new Error(code), { code, status, ...extra })

export function createTerminalKeyLoader({ authMediation, operatorBotId, loader = TERMINAL_KEY_LOADER }) {
  const refused = new Set()
  return {
    // Terminals without a mediated item fall back to usage: load() throws KEY_NOT_MEDIATED for them.
    owns: () => true,
    // Optimistic: no value is read to answer this; the last refusal for the terminal turns it off until a load succeeds.
    available: async terminalId => ({ available: !refused.has(terminalId), revision: 1 }),
    async load({ terminalId, ref, handle, revision }) {
      const facade = authMediation()
      if (!facade) throw failed('CREDENTIAL_UNAVAILABLE')
      const answer = await facade.exec({ botId: operatorBotId, command: [loader, terminalId], args: ['--ref', ref, '--handle', handle, '--revision', String(revision)], timeoutSec: 60 })
        .catch(() => null)
      if (answer?.outcome === 'not-registered') throw failed('KEY_NOT_MEDIATED', 404)
      if (answer?.outcome !== 'granted') { refused.add(terminalId); throw failed('CREDENTIAL_UNAVAILABLE') }
      let dto
      try { dto = JSON.parse(String(answer.stdout).trim()) } catch { throw failed() }
      if (answer.exit_code === 0 && dto?.schema === 'aiterm.credential-load.v1') { refused.delete(terminalId); return dto }
      if (answer.exit_code === 2 && dto?.schema === 'aiterm.remote-binding-error.v1')
        throw failed(typeof dto.code === 'string' ? dto.code : 'TERMINAL_KEY_LOAD_REFUSED', 409, { binding: dto })
      throw failed()
    },
  }
}
