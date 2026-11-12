// Startable notices (Lattice 0.90.0; waiting marks 0.92.0, Lattice docs/architecture/dfd-done-notice.md) to the lane's Bot and every
// waiting Bot through the public send path (effect messages.send -> messenger.sendmessage; waking a sleeping seat stays the messenger's). README L10-L12.
export const NOTICE_SLICE = 50
// Messenger results that confirm the message was accepted; anything else (refused, unknown, failed, stopped, thrown) is retried later.
const ACCEPTED = new Set(['running', 'steered', 'queued', 'delivered', 'answered'])

const triggerText = trigger => `${trigger.kind ?? 'change'} of ${trigger.plan_key}/${trigger.task_id ?? trigger.phase_id}`
  + (trigger.actor?.agent ? ` by ${trigger.actor.agent}` : '')

// Owner ruling 2026-11-12: a startable notice is information, never an order; the lane decides whether to start.
// A recipient that ran `todo wait` (0.92.0) is woken by it: the text names its wait; a waiter that is not the lane is told who starts it.
export function noticeMessage(projectId, notice, target = notice.lane) {
  const done = notice.triggers?.length ? ` (prerequisite ${notice.triggers.map(triggerText).join(', ')})` : ''
  const wait = notice.waiting?.find(entry => entry.agent === target)
  const waited = wait ? `, which you are waiting for (todo wait since ${wait.since}${wait.reason ? `: ${wait.reason}` : ''}),` : ''
  const lane = target === notice.lane
  return [
    `Lattice notice (information, not a request): task ${notice.plan_key}/${notice.task_id} 「${notice.title}」 on chart ${projectId} (lane ${notice.lane})${waited} can start now${done}.`,
    lane ? 'Whether and when to start is your call; keep your current work if it comes first.'
      : `The lane ${notice.lane} starts it; your wait ends when it is started or retired (todo wait --cancel ends it now).`,
    notice.done_condition ? `Done condition: ${notice.done_condition}` : null,
    lane ? `For reference, if you start it: ${notice.next_action} (lattice tool, project ${projectId}).` : null,
  ].filter(Boolean).join('\n').slice(0, 4000)
}

// run(id, args) -> parsed Lattice JSON, throws on a failed CLI run.
export function createNoticeDelivery({ run, log }) {
  // Charts whose notices may still be unacked (failed send, notices:null, slice exhausted): re-listed at their next run and at deliver.
  const pending = new Set()
  // Recipients already covered per unacked (chart, notice_id, waiting_digest), so a retry wakes nobody twice; dropped on ack.
  const covered = new Map()

  // Sends each notice to its roster recipients (lane + waiters), then acks per lane once all are covered.
  // sender = the Bot whose write released them; null = recovery.
  async function send(projectId, notices, { sender, roster, effect, budget }) {
    const bots = new Set(roster.filter(member => !member.deleting).map(member => member.id))
    const acks = new Map(), out = { delivered: 0, failed: 0 }
    const ack = (lane, id, key) => acks.set(lane, [...acks.get(lane) ?? [], [id, key]])
    for (const notice of notices) {
      if (notice.acked) continue
      const recipients = [...new Set([notice.lane, ...(notice.waiting ?? []).map(entry => entry.agent)])].filter(id => bots.has(id))
      if (!recipients.length) continue
      const actor = notice.triggers?.at(-1)?.actor?.agent
      const from = sender ?? (bots.has(actor) ? actor : 'scheduler')
      const key = `${projectId}\0${notice.notice_id}\0${notice.waiting_digest ?? ''}`
      // The releasing Bot already sees it in its own tool result; acked_recipients were informed under an earlier waiter set.
      const done = covered.get(key) ?? new Set([from, ...(notice.acked_recipients ?? [])])
      covered.set(key, done)
      let complete = true
      for (const target of recipients) {
        if (done.has(target)) continue
        if (budget.left <= 0) { pending.add(projectId); complete = false; break }
        budget.left--
        const value = await effect('messages.send', { from, target, message: noticeMessage(projectId, notice, target) }).catch(() => null)
        // Only a confirmed acceptance covers a recipient; the notice stays unacked and the chart is re-listed at the next run or generation.
        if (!ACCEPTED.has(value?.delivery)) { out.failed++; pending.add(projectId); complete = false; continue }
        done.add(target)
        out.delivered++
      }
      // shortcut: a notice with no lane cannot be acked; only `covered` stops re-sends, so a new child generation sends it again. Upgrade if lane-less waited tasks appear.
      if (complete && typeof notice.lane === 'string') ack(notice.lane, notice.notice_id, key)
      if (budget.left <= 0 && !complete) break
    }
    for (const [lane, entries] of acks) {
      try {
        await run(projectId, ['todo', 'notice', 'ack', '--lane', lane, '--notice', entries.map(([id]) => id).join(',')])
        for (const [, key] of entries) covered.delete(key)
      } catch (error) {
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
