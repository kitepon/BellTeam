import { readFileSync } from 'node:fs'

// The commit order this image was built from: one 40-hex id per line, newest first (written by scripts/package-server.mjs).
// docs/architecture/modules/runtime/module-process.md, "A published row is never new next to a newer builtin" (a518).
// null when the file is absent (a repository run) or empty: the update compare then keeps its old commit-equality rule.
export function loadSourceHistory(file = new URL('../config/source-history.txt', import.meta.url)) {
  let text
  try { text = readFileSync(file, 'utf8') } catch { return null }
  const ids = text.split('\n').filter(line => /^[a-f0-9]{40}$/.test(line))
  return ids.length ? new Set(ids) : null
}
