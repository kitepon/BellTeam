import { readFile, writeFile, rename } from 'node:fs/promises'

export const emptyPolicy = () => ({ version: 2, vault: '', cache_seconds: 3600, admins: [], bots: {}, units: {}, stopped: [] })

const live = (grant, now) => !grant.expires || now < Date.parse(grant.expires)

// Outcome of the authorization step; nothing is read from 1Password before this says 'granted'.
export function authorize(policy, caller, name, cwd, now) {
  if (policy.stopped.includes(name)) return 'stopped'
  const grants = (caller.kind === 'bot' ? policy.bots[caller.id] : policy.units[caller.folder])?.grants ?? []
  return grants.some(g => g.command === name && (!g.cwd || g.cwd === cwd) && live(g, now)) ? 'granted' : 'denied'
}

const BOT_ROOT = /^\/srv\/bellteam\/bots\/(bot-[a-f0-9]+)(\/.*)?$/u
// Sakura's policy.json v1: bots[].root, bots[].grants[[command, expires?]], stopped[], vault, cache_seconds.
// Every container grant keeps its registered folder as `cwd` (the old broker matched it exactly), so no grant gets wider.
export function importV1(policy, v1, host) {
  const next = structuredClone(policy)
  next.vault ||= v1.vault
  next.cache_seconds = v1.cache_seconds ?? next.cache_seconds
  let count = 0
  for (const bot of v1.bots) {
    const grants = bot.grants.map(([command, expires]) => ({ command, ...(expires ? { expires } : {}) }))
    if (host === 'container') {
      const m = BOT_ROOT.exec(bot.root)
      if (!m) throw new Error('AUTH_IMPORT_ROOT')
      const entry = next.bots[m[1]] ??= { grants: [] }
      entry.grants.push(...grants.map(g => ({ ...g, cwd: bot.root })))
    } else (next.units[bot.root] ??= { grants: [] }).grants.push(...grants)
    count += grants.length
  }
  for (const name of v1.stopped ?? []) if (!next.stopped.includes(name)) next.stopped.push(name)
  return { policy: next, count }
}

// firstAdmins: Bot IDs from the body's environment (seats cannot edit it). They are always administrators, so a new install can run token.set and import.
export function createPolicyStore(path, firstAdmins = []) {
  return {
    read: async () => {
      const policy = { ...emptyPolicy(), ...JSON.parse(await readFile(path, 'utf8').catch(error => error.code === 'ENOENT' ? '{}' : Promise.reject(error))) }
      policy.admins = [...new Set([...policy.admins, ...firstAdmins])]
      return policy
    },
    write: async policy => { const tmp = path + '.tmp'; await writeFile(tmp, JSON.stringify(policy, null, 2), { mode: 0o600 }); await rename(tmp, path) },
  }
}
