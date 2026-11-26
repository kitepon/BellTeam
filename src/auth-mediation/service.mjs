import { appendFile } from 'node:fs/promises'
import { createAuthCore } from './core.mjs'
import { createItemCache, opRunner } from './items.mjs'
import { botForCwd } from './identity.mjs'
import { createPolicyStore } from './policy.mjs'
import { redact } from './redact.mjs'

const CAP = 65536
const clip = text => text.length > CAP ? { text: text.slice(0, CAP), cut: true } : { text, cut: false }

// A request runs one at a time (the channel serializes root calls), so `current` is the effect of the call in progress.
export function createAuthMediationService({ policyPath, auditPath, opExe, appendLine = (path, line) => appendFile(path, line, { mode: 0o600 }), runOp = null, realpath = undefined }) {
  let current = null
  const withToken = async consume => {
    const got = await current('secret.get', {})
    if (got.unavailable) throw new Error('AUTH_NO_TOKEN')
    return consume(got.value)
  }
  const items = createItemCache({ runOp: args => (runOp ?? opRunner({ exe: opExe, withToken }))(args) })
  const core = createAuthCore({ realpath, store: createPolicyStore(policyPath), items, roots: async () => (await current('members.roots', {})).roots,
    audit: line => appendLine(auditPath, JSON.stringify(line) + '\n') })
  const within = async (effect, work) => { current = effect; try { return await work() } finally { current = null } }
  return {
    resolve: (params, effect) => within(effect, async () => {
      const result = await core.resolve(params)
      if (result.outcome !== 'granted' || params.via !== 'mcp') return result
      // Run path: the Bot's own seat runs the one fixed command; secrets go in through the runner and come back redacted.
      const run = await effect('seat.run', { botId: params.botId, cwd: params.cwd, argv: [...params.command, ...(params.args ?? [])],
        env: result.env, timeoutMs: (params.timeoutSec ?? 600) * 1000 })
      const out = clip(redact(run.stdout, result.env)), err = clip(redact(run.stderr, result.env))
      return { outcome: 'granted', exit_code: run.exitCode, stdout: out.text, stderr: err.text, truncated: run.truncated || out.cut || err.cut || run.timedOut, cache: result.cache }
    }),
    admin: (input, effect) => within(effect, async () => {
      // The container socket sends the peer cwd; the Bot is the registered root that contains it (same rule as a script caller).
      const params = { ...input, botId: input.botId ?? botForCwd((await effect('members.roots', {})).roots, input.cwd) }
      if (!params.botId) return { outcome: 'denied', error: 'The caller is not registered.' }
      if (params.verb === 'token.set' || params.verb === 'token.clear') {
        if (!(await core.admin(params.botId, 'show')).policy) return { outcome: 'denied', error: 'Not an administrator.' }
        const value = params.args?.value
        if (params.verb === 'token.set') await effect('secret.put', { value })
        else await effect('secret.erase', {})
        items.flush()
        return { outcome: 'ok' }
      }
      return core.admin(params.botId, params.verb, params.args ?? {})
    }),
    status: (params, effect) => within(effect, async () => ({ state: (await effect('secret.get', {})).unavailable ? 'no-token' : 'ready' })),
  }
}
