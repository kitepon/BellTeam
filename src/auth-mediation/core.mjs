import { randomUUID } from 'node:crypto'
import { authorize, importV1 } from './policy.mjs'
import { envReturn, runEnv } from './env.mjs'
import { botForCwd, callerKey } from './identity.mjs'

const NOT_REGISTERED = 'This command is not registered.'
const REFUSALS = { stopped: 'This command is stopped by the operator.', denied: 'This command is not permitted.' }

// store: {read, write}; items: createItemCache; audit: line => Promise; roots: () => {botId: absoluteRoot}.
export function createAuthCore({ store, items, audit, roots, now = () => new Date() }) {
  // An audit failure never refuses a request (the diagnostic is the caller's); it is swallowed here by design.
  const record = (rec, outcome, extra = {}) => { void Promise.resolve(audit({ ...rec, outcome, ...extra })).catch(() => {}) }

  // request: {command: string[], cwd, via: 'mcp'|'container-socket'|'host-socket', botId?, unit?}
  async function resolve(request) {
    const at = now()
    const policy = await store.read()
    const name = request.command.join(' ')
    const caller = request.botId ? { kind: 'bot', id: request.botId }
      : request.unit ? { kind: 'unit', folder: request.unit }
        : (id => id && { kind: 'bot', id })(botForCwd(await roots(), request.cwd))
    const rec = { time: at.toISOString(), request_id: randomUUID(), caller: caller ? callerKey(caller) : null, item: name, via: request.via, cwd: request.cwd }
    if (!caller || request.command.length === 0) { record(rec, 'unknown-caller'); return { outcome: 'unknown-caller', error: 'The caller is not registered.' } }
    const verdict = authorize(policy, caller, name, request.cwd, at.getTime())
    if (verdict !== 'granted') {
      if (verdict === 'stopped') items.flush(name)
      record(rec, verdict); return { outcome: verdict, error: REFUSALS[verdict] }
    }
    const found = await items.get(name, policy.vault, policy.cache_seconds)
    const env = found && (request.via === 'mcp' ? runEnv : envReturn)(found.fields, request.command[0])
    if (!env || Object.keys(env).length === 0) { record(rec, found ? 'error' : 'not-registered'); return { outcome: found ? 'error' : 'not-registered', error: NOT_REGISTERED } }
    record(rec, 'granted', { cache: found.hit ? 'hit' : 'miss' })
    return { outcome: 'granted', env, cache: found.hit ? 'hit' : 'miss' }
  }

  // Admin verbs run only for a Bot listed in policy.admins; the change is audited and the item cache is dropped.
  async function admin(botId, verb, args = {}) {
    const policy = await store.read()
    if (!policy.admins.includes(botId)) { record({ time: now().toISOString(), request_id: randomUUID(), caller: `bot:${botId}`, item: args.command ?? null, via: 'admin' }, 'denied'); return { outcome: 'denied', error: 'Not an administrator.' } }
    const entry = args.unit ? (policy.units[args.unit] ??= { grants: [] }) : args.bot ? (policy.bots[args.bot] ??= { grants: [] }) : null
    let result = {}
    if (verb === 'grant') entry.grants.push({ command: args.command, ...(args.cwd ? { cwd: args.cwd } : {}), ...(args.expires ? { expires: args.expires } : {}) })
    else if (verb === 'revoke') entry.grants = entry.grants.filter(g => g.command !== args.command || (args.cwd && g.cwd !== args.cwd))
    else if (verb === 'stop') { if (!policy.stopped.includes(args.command)) policy.stopped.push(args.command) }
    else if (verb === 'resume') policy.stopped = policy.stopped.filter(c => c !== args.command)
    else if (verb === 'flush') { items.flush(args.command); return { outcome: 'ok' } }
    else if (verb === 'show') return { outcome: 'ok', policy }
    else if (verb === 'import') { const out = importV1(policy, args.policy, args.host); Object.assign(policy, out.policy); result = { count: out.count } }
    else return { outcome: 'error', error: 'Unknown verb.' }
    await store.write(policy)
    if (args.command) items.flush(args.command)
    record({ time: now().toISOString(), request_id: randomUUID(), caller: `bot:${botId}`, item: args.command ?? null, via: 'admin' }, verb)
    return { outcome: 'ok', ...result }
  }
  return { resolve, admin }
}
