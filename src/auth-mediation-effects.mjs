import { createSeatProcessRunner } from './seat-process.mjs'

// Body side of the auth-mediation child's effects (docs/architecture/modules/runtime/auth-mediation-child.md, data-flow rows P3-P5).
// The child names no file, network or process of its own: only these fixed methods, validated by its protocol on both ends.
export const AUTH_MEDIATION_TOKEN_SCOPE = Object.freeze({ terminalId: 'auth-mediation', purpose: 'auth-mediation.op-read' })
export const SEAT_RUN_OUTPUT_LIMIT = 64 * 1024
const fail = (code, status = 503) => Object.assign(new Error(code), { code, status })
const cut = text => text.length > SEAT_RUN_OUTPUT_LIMIT ? [text.slice(0, SEAT_RUN_OUTPUT_LIMIT), true] : [text, false]

export function createAuthMediationEffects({ bots, credentials = null, scope = AUTH_MEDIATION_TOKEN_SCOPE, seatRunner = project => createSeatProcessRunner(project, { environment: 'base' }),
  signalFor = timeoutMs => AbortSignal.timeout(timeoutMs) }) {
  const tokenAvailable = async () => {
    if (typeof credentials?.current !== 'function') throw fail('AUTH_MEDIATION_SECRET_UNAVAILABLE')
    const current = await credentials.current(scope)
    return current?.available === true ? current : null
  }
  return async (method, params) => {
    switch (method) {
      // Registered Bot roots only, for the container socket's peer-cwd match. Read only.
      case 'members.roots': {
        const roots = {}
        for (const item of await bots.listForClient()) {
          const id = String(item?.id ?? '')
          if (/^[a-z0-9][a-z0-9-]{0,63}$/u.test(id)) roots[id] = bots.projectPath(id)
        }
        return { roots }
      }
      // The token is handed to the child for one request, from inside usage's callback; it is never stored here. Not set / source lost = unavailable (the child answers "not registered").
      case 'secret.get': {
        const current = await tokenAvailable().catch(() => null)
        if (!current) return { unavailable: true }
        return credentials.withResolved(current.handle, { ...scope, memberId: null }, value => ({ value }))
          .catch(error => { if (error?.code === 'SECRET_SOURCE_UNAVAILABLE') return { unavailable: true }; throw error })
      }
      case 'secret.put':
        if (typeof credentials?.put !== 'function') throw fail('AUTH_MEDIATION_SECRET_UNAVAILABLE')
        await credentials.put(scope, params.value)
        return { stored: true }
      case 'secret.erase':
        if (typeof credentials?.erase !== 'function') throw fail('AUTH_MEDIATION_SECRET_UNAVAILABLE')
        await credentials.erase(scope)
        return { erased: true }
      // MCP run-and-return. The child already refused a cwd outside the Bot's project; the runner's project is the Bot's root (it fixes PATH, npm prefix and BELLTEAM_PROJECT),
      // and a cwd below it is applied with env --chdir (a folder argument, not a secret). The secret environment goes only on the runner's stdin line (O2).
      case 'seat.run': {
        const root = bots.projectPath(params.botId)
        const [command, ...args] = params.argv
        // env would read NAME=value after "--" as an assignment: the command word must not look like one.
        if (params.cwd !== root && (params.argv[0].includes('=') || !params.cwd.startsWith(root + '/'))) throw fail('AUTH_MEDIATION_SEAT_RUN_REFUSED', 400)
        const run = seatRunner(root)
        const options = { acceptNonzero: true, signal: signalFor(params.timeoutMs), ...(Object.keys(params.env).length ? { secretEnv: params.env } : {}) }
        try {
          const result = params.cwd === root ? await run(command, args, options) : await run('/usr/bin/env', [`--chdir=${params.cwd}`, '--', command, ...args], options)
          const [stdout, outCut] = cut(result.stdout), [stderr, errCut] = cut(result.stderr)
          return { exitCode: result.code ?? null, stdout, stderr, truncated: outCut || errCut, timedOut: false }
        } catch (error) {
          if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return { exitCode: null, stdout: '', stderr: '', truncated: false, timedOut: true }
          if (error?.code === 'SEAT_BUFFER_EXCEEDED') return { exitCode: null, stdout: '', stderr: '', truncated: true, timedOut: false }
          throw error
        }
      }
      default: throw fail('AUTH_MEDIATION_EFFECT_INVALID', 400)
    }
  }
}
