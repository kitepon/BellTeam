// Parent side of the auth-mediation child (docs/architecture/modules/runtime/auth-mediation-child.md).
// One root call per request; the facade fills what the parent knows (the seat's project root) and turns "the module is not running" into an audited-by-nobody answer
// every client already understands: outcome "error", never a direct read of 1Password by the client.
const NOT_RUNNING = 'the authentication module is not running'
const clean = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))

export function createAuthMediationFacade({ controller, bots }) {
  const call = (method, params) => Promise.resolve().then(() => controller.request(method, params))
  const resolve = params => call('resolve', clean(params)).catch(error => {
    // A refused request (bad shape) is the caller's mistake; everything else means the child is not serving.
    if (error?.code === 'AUTH_MEDIATION_INVALID') return { outcome: 'error', error: 'request invalid' }
    return { outcome: 'error', error: NOT_RUNNING }
  })
  return {
    // T1: the MCP tool. The Bot ID is the one resolveSeatBotId yielded (the caller passes it; no Bot ID travels in the arguments). Fork seats are refused before this call.
    exec: ({ botId, command, args = [], cwd, timeoutSec }) => resolve({ command, args, cwd: cwd ?? bots.projectPath(botId), via: 'mcp', botId, timeoutSec }),
    // T2a / T2b: the sockets. The socket code supplies the peer's cwd (container) or the client's folder (host); the child matches it exactly to a registered root or unit.
    containerSocket: ({ command, args = [], cwd }) => resolve({ command, args, cwd, via: 'container-socket' }),
    hostSocket: ({ command, args = [], cwd, unit }) => resolve({ command, args, cwd, via: 'host-socket', unit: unit ?? cwd }),
    // The container socket sends the peer cwd (the child finds the Bot from the registered roots); the MCP-side callers send a Bot ID. Exactly one of the two.
    admin: ({ botId, cwd, verb, args, program }) => call('admin', clean({ botId, cwd, verb, args, program })).catch(() => ({ outcome: 'error', error: NOT_RUNNING })),
    // Key use on a container caller's own socket: the unit is the socket's path (named by the relay). The module uses the key inside itself and answers with the result only.
    keyuse: ({ action, name, data, aad, flags, via, cwd, unit }) => call('keyuse', clean({ action, name, data, aad, flags, via, cwd, unit })).catch(error => error?.code === 'AUTH_MEDIATION_INVALID' ? { outcome: 'error', error: 'request invalid' } : { outcome: 'error', error: NOT_RUNNING }),
    // Mail: the module logs in to the item's SMTP server and sends; only the result comes back.
    mail: params => call('mail', clean(params)).catch(error => error?.code === 'AUTH_MEDIATION_INVALID' ? { outcome: 'error', error: 'request invalid' } : { outcome: 'error', error: NOT_RUNNING }),
    // Http: the module makes the request with the credential added and returns the response only.
    http: params => call('http', clean(params)).catch(error => error?.code === 'AUTH_MEDIATION_INVALID' ? { outcome: 'error', error: 'request invalid' } : { outcome: 'error', error: NOT_RUNNING }),
    status: () => call('status', {}).catch(() => ({ state: 'unavailable' })),
  }
}
