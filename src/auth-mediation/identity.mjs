// Caller identity. A Bot is the unique registered root that contains the peer's working folder (today's rule, widened
// from "equals" to "contains" because the grant's own cwd keeps it as narrow as before). A unit is a folder, exact.
export function botForCwd(roots, cwd) {
  const found = Object.entries(roots).filter(([, root]) => cwd === root || cwd.startsWith(root + '/'))
  // A nested registered root wins over its parent only when it is the longest match; two equal matches are ambiguous.
  found.sort((a, b) => b[1].length - a[1].length)
  if (found.length === 0 || (found.length > 1 && found[0][1].length === found[1][1].length)) return null
  return found[0][0]
}

export const callerKey = caller => caller.kind === 'bot' ? `bot:${caller.id}` : `unit:${caller.folder}`
