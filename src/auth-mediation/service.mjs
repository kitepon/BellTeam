import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFile, readFile } from 'node:fs/promises'
import { createAuthCore } from './core.mjs'
import { createItemCache, opRunner } from './items.mjs'
import { botForCwd } from './identity.mjs'
import { createPolicyStore } from './policy.mjs'
import { redact } from './redact.mjs'

const CAP = 65536
// A long MCP run holds one of the child's 8 slots; keeping 4 for the socket callers means main-server deploys are never starved by Bot runs.
const MAX_MCP_RUNS = 4
const clip = text => text.length > CAP ? { text: text.slice(0, CAP), cut: true } : { text, cut: false }

// Requests run side by side; each call's effect travels with it (AsyncLocalStorage), so a long run never blocks or mixes up another request.
export function createAuthMediationService({ policyPath, auditPath, opExe, firstAdmins = [], appendLine = (path, line) => appendFile(path, line, { mode: 0o600 }), runOp = null, realpath = undefined }) {
  const calls = new AsyncLocalStorage(), current = (method, params) => calls.getStore()(method, params)
  let adminTail = Promise.resolve(), mcpRuns = 0
  const withToken = async consume => {
    const got = await current('secret.get', {})
    if (got.unavailable) throw new Error('AUTH_NO_TOKEN')
    return consume(got.value)
  }
  const items = createItemCache({ runOp: args => (runOp ?? opRunner({ exe: opExe, withToken }))(args) })
  const core = createAuthCore({ realpath, store: createPolicyStore(policyPath, firstAdmins), items, roots: async () => (await current('members.roots', {})).roots,
    audit: line => appendLine(auditPath, JSON.stringify(line) + '\n') })
  const within = (effect, work) => calls.run(effect, work)
  // Admin verbs read, change and rewrite policy.json, so they run one after another.
  const serial = work => { const next = adminTail.then(work, work); adminTail = next.catch(() => {}); return next }
  return {
    resolve: (params, effect) => within(effect, async () => {
      if (params.via === 'mcp') {
        if (mcpRuns >= MAX_MCP_RUNS) return { outcome: 'error', error: 'Too many runs are in progress; use the socket client (auth exec) for long commands.' }
        mcpRuns++
      }
      try {
        const result = await core.resolve(params)
        if (result.outcome !== 'granted' || params.via !== 'mcp') return result
        // Run path: the Bot's own seat runs the one fixed command; secrets go in through the runner and come back redacted.
        const run = await effect('seat.run', { botId: params.botId, cwd: params.cwd, argv: [...params.command, ...(params.args ?? [])],
          env: result.env, timeoutMs: (params.timeoutSec ?? 600) * 1000 })
        const out = clip(redact(run.stdout, result.env)), err = clip(redact(run.stderr, result.env))
        return { outcome: 'granted', exit_code: run.exitCode, stdout: out.text, stderr: err.text, truncated: run.truncated || out.cut || err.cut || run.timedOut, cache: result.cache }
      } finally { if (params.via === 'mcp') mcpRuns-- }
    }),
    admin: (input, effect) => within(effect, () => serial(async () => {
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
      if (params.verb === 'audit') {
        // The audit file is readable only by the body, so operators read it through this verb (admins only, last N lines, no values are in it).
        if ((await core.admin(params.botId, 'show')).outcome !== 'ok') return { outcome: 'denied', error: 'Not an administrator.' }
        const last = Math.min(Math.max(Number.isInteger(params.args?.last) ? params.args.last : 50, 1), 500)
        const text = await readFile(auditPath, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))
        return { outcome: 'ok', lines: text.split('\n').filter(Boolean).slice(-last) }
      }
      return core.admin(params.botId, params.verb, params.args ?? {}, input.program)
    })),
    keyuse: (params, effect) => within(effect, () => core.keyuse(params)),
    http: (params, effect) => within(effect, () => core.http(params)),
    mail: (params, effect) => within(effect, () => core.mail(params)),
    status: (params, effect) => within(effect, async () => ({ state: (await effect('secret.get', {})).unavailable ? 'no-token' : 'ready' })),
  }
}
