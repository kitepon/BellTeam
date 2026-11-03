import { createHash } from 'node:crypto'

export const isObserverProjectScope = value => typeof value === 'string' && /^tlop1\.[a-f0-9]{64}$/u.test(value)
export const observerProjectScope = project => isObserverProjectScope(project) ? project
  : `tlop1.${createHash('sha256').update(project, 'utf8').digest('hex')}`

// Use the parent's real JSON path width so hiding paths does not change public CLI chunk boundaries.
export function observerScopedRequests(projects) {
  const requests = [], ids = new Set(), base = Buffer.byteLength(JSON.stringify({ schema: 'throughline.observer_check_request.v1', projects: [] }))
  let chunk = [], size = base
  for (const { id, scope, projectBytes, after } of projects) {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(id) || ids.has(id) || !isObserverProjectScope(scope)
      || !Number.isSafeInteger(projectBytes) || projectBytes < 3 || projectBytes > 24578
      || !(after === null || typeof after === 'string' && Buffer.byteLength(after) >= 1 && Buffer.byteLength(after) <= 512))
      throw new Error('THROUGHLINE_OBSERVER_CHECK_INVALID')
    ids.add(id)
    const length = Buffer.byteLength(JSON.stringify({ id, projectPath: null, after })) - 4 + projectBytes
    if (base + length > 1024 * 1024) throw new Error('THROUGHLINE_OBSERVER_CHECK_INVALID')
    if (chunk.length === 256 || size + (chunk.length ? 1 : 0) + length > 1024 * 1024) {
      requests.push({ projects: chunk }); chunk = []; size = base
    }
    size += (chunk.length ? 1 : 0) + length; chunk.push({ id, scope, after })
  }
  if (chunk.length) requests.push({ projects: chunk })
  return requests
}
