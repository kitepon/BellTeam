// A schedule document has one writer at a time within its owning registry.
// This is a short-lived mutation lock, not a delivery queue or retry policy.
const owners = new WeakMap()

export function scheduleRevision(schedule) {
  const revision = schedule?.revision === undefined ? 0 : schedule.revision
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('SCHEDULE_REVISION_INVALID')
  return revision
}

export function nextScheduleRevision(schedule) {
  const revision = scheduleRevision(schedule)
  if (revision === Number.MAX_SAFE_INTEGER) throw new Error('SCHEDULE_REVISION_INVALID')
  return revision + 1
}

export async function mutateSchedules(registry, id, edit) {
  if (!owners.has(registry)) owners.set(registry, new Map())
  const pending = owners.get(registry), previous = pending.get(id)
  let release
  const current = new Promise(resolve => { release = resolve })
  pending.set(id, current)
  await previous
  try {
    const result = await edit(await registry.listSchedules(id))
    if (result.schedules) await registry.writeScheduleDocument(id, result.schedules)
    return result.value
  } finally {
    release()
    if (pending.get(id) === current) pending.delete(id)
  }
}
