// Startable notices (Lattice 0.90.0, Lattice docs/architecture/dfd-done-notice.md) to the lane's Bot through the public send path
// (effect messages.send -> messenger.sendmessage; waking a sleeping seat stays the messenger's). README L10-L12.
export const NOTICE_SLICE = 50
const FAILED = new Set(['failed', 'stopped'])

const triggerText = trigger => `${trigger.kind ?? 'change'} of ${trigger.plan_key}/${trigger.task_id ?? trigger.phase_id}`
  + (trigger.actor?.agent ? ` by ${trigger.actor.agent}` : '')

// Owner ruling 2026-11-12: a startable notice is information, never an order; the lane decides whether to start.
export function noticeMessage(projectId, notice) {
  const done = notice.triggers?.length ? ` (prerequisite ${notice.triggers.map(triggerText).join(', ')})` : ''
  return [
    `Lattice notice (information, not a request): task ${notice.plan_key}/${notice.task_id} 「${notice.title}」 on chart ${projectId} (lane ${notice.lane}) can start now${done}.`,
    'Whether and when to start is your call; keep your current work if it comes first.',
    notice.done_condition ? `Done condition: ${notice.done_condition}` : null,
    `For reference, if you start it: ${notice.next_action} (lattice tool, project ${projectId}).`,
  ].filter(Boolean).join('\n').slice(0, 4000)
}

// run(id, args) -> parsed Lattice JSON, throws on a failed CLI run.
export function createNoticeDelivery({ run, log }) {
  // Charts whose notices may still be unacked (failed send, notices:null, slice exhausted): re-listed at their next run and at deliver.
  const pending = new Set()

  // Sends each notice whose lane is a roster Bot, then acks per lane. sender = the Bot whose write released them; null = recovery.
  async function send(projectId, notices, { sender, roster, effect, budget }) {
    const bots = new Set(roster.filter(member => !member.deleting).map(member => member.id))
    const acks = new Map(), out = { delivered: 0, failed: 0 }
    const ack = (lane, id) => acks.set(lane, [...acks.get(lane) ?? [], id])
    for (const notice of notices) {
      if (notice.acked || !bots.has(notice.lane)) continue
      const actor = notice.triggers?.at(-1)?.actor?.agent
      const from = sender ?? (bots.has(actor) ? actor : 'scheduler')
      // The releasing Bot already sees it in its own tool result.
      if (notice.lane === from) { ack(notice.lane, notice.notice_id); continue }
      if (budget.left <= 0) { pending.add(projectId); break }
      budget.left--
      const value = await effect('messages.send', { from, target: notice.lane, message: noticeMessage(projectId, notice) }).catch(() => null)
      // A thrown effect (old body: LATTICE_INVALID, timeout) or a failed delivery stays unacked; 'refused' is permanent (deleted Bot), so it is acked.
      if (value === null || FAILED.has(value.delivery)) { out.failed++; pending.add(projectId); continue }
      ack(notice.lane, notice.notice_id)
      if (value.delivery !== 'refused') out.delivered++
    }
    for (const [lane, ids] of acks) {
      try { await run(projectId, ['todo', 'notice', 'ack', '--lane', lane, '--notice', ids.join(',')]) } catch (error) {
        pending.add(projectId)
        log(`lattice-notice-ack ${projectId} ${error.code ?? 'LATTICE_CLI_FAILED'}`)
      }
    }
    return out
  }

  async function recover(projectId, context) {
    pending.delete(projectId)
    let listed
    try { listed = await run(projectId, ['todo', 'notice', 'list', '--json']) } catch (error) {
      pending.add(projectId)
      log(`lattice-notice-list ${projectId} ${error.code ?? 'LATTICE_CLI_FAILED'}`)
      return { delivered: 0, failed: 0 }
    }
    return send(projectId, Array.isArray(listed?.notices) ? listed.notices : [], { ...context, sender: null })
  }

  return {
    // After a seat run: the result's notices first; a chart with notices:null or earlier failures is re-listed.
    async afterRun(projectId, result, { from, roster, effect }) {
      // No roster yet (first members.list failed): nothing can be matched to a Bot, so the chart waits for the next run or deliver.
      if (!roster.length) { pending.add(projectId); return }
      const context = { roster, effect, budget: { left: NOTICE_SLICE } }
      // Only notices left from before this run (or notices:null) are re-listed, so a send that just failed is not retried at once.
      const earlier = pending.has(projectId)
      const carries = result && typeof result === 'object' && Object.hasOwn(result, 'notices')
      if (carries && Array.isArray(result.notices)) await send(projectId, result.notices, { ...context, sender: from })
      if (earlier || (carries && !Array.isArray(result.notices))) await recover(projectId, context)
    },
    // Root deliver (each new child generation): every chart, at most NOTICE_SLICE sends per call; the rest wait for the next run or deliver.
    async deliverAll(ids, { roster, effect, lock = (id, fn) => fn() }) {
      const budget = { left: NOTICE_SLICE }, total = { delivered: 0, failed: 0 }
      for (const id of ids) {
        if (budget.left <= 0) { pending.add(id); continue }
        const out = await lock(id, () => recover(id, { roster, effect, budget }))
        total.delivered += out.delivered; total.failed += out.failed
      }
      return total
    },
  }
}
