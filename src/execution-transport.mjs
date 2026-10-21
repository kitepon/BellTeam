// Optional integration: supplied only after the Aiterm execution runtime is
// accepted. No live mount, relation graph, retry or legacy-close fallback here.
import { isDeepStrictEqual as same } from 'node:util'
import { callExecutionRef, deliveryExecutionRef, roomExecutionRef } from './execution-bridge.mjs'

const unknown = cause => Object.assign(new Error('停止を確認できませんでした。', { cause }), { code: 'BOT_STOP_UNCONFIRMED' })

export async function reserveExecution(transport, job) {
  const observed = await transport.observe(job.bot)
  if (observed?.schema !== 'aiterm.pty-observe-result.v1' || observed.session_id !== transport.session(job.bot)
    || typeof observed.exists !== 'boolean' || (observed.exists ? !/^[0-9a-f]{32}$/u.test(observed.launch_id ?? '') : observed.launch_id !== null))
    throw unknown()
  const deliveryId = job.info.groupId ?? job.id
  const request = job.info.call
    ? callExecutionRef({ ...job.info.call, deliveryId }, observed.session_id)
    : (job.info.context === 'room' ? roomExecutionRef : deliveryExecutionRef)(deliveryId, observed.session_id)
  const source = job.executionSource?.source ?? { launch: null, boundary: null }
  job.execution = await transport.executionBridge.reserve({
    request,
    sourceSession: job.executionSource?.sourceSession ?? null, source,
    targetSession: observed.session_id, expectedLaunch: observed.launch_id,
  }, { sourceContext: source.launch ? source : null })
  job.executionWasPresent = observed.exists
}

export async function dispatchExecution(transport, job, bot, message, images, { setupTest, check }) {
  check()
  const imageFiles = await transport.imageFiles(images)
  try {
    check()
    const execution = job.execution
    let session = transport.session(bot)
    if (!job.executionWasPresent) session = await transport.wake(bot, { setupTest, execution })
    check()
    const result = await execution.invoke('pty_send', { session_id: session, text: message, require_agent: true,
      ...(imageFiles.length ? { image: imageFiles.map(file => file.path) } : {}) }, { meta: { 'aiterm/caller': 'BellTeam' } })
    const receipt = result.structuredContent
    if (receipt?.mode !== 'agent_steer'
      && (receipt?.mode !== 'agent_dispatch' || !Number.isInteger(receipt.event_cursor) || !receipt.wait_process))
      throw unknown()
    return { receipt, result, imageFiles, session }
  } catch (error) {
    await transport.removeTemporaryImages(imageFiles)
    throw error
  }
}

export async function finishExecution(job, kind) {
  const handle = job.execution
  if (!handle) return
  const target = handle.binding?.target
  if (kind === 'completion' && !target?.boundary || kind === 'interrupted' && !target) return
  try {
    await handle.finish(kind === 'not_sent' ? { kind } : { kind, target: kind === 'interrupted' ? target.launch : target })
  } catch {
    // Delivery completion is separate from relation/fence confirmation. Keep
    // the accepted result; the Aiterm record remains unresolved, never resent.
    job.executionFinishUnconfirmed = true
  }
}

export async function applyExecutionStop(job) {
  const target = job.execution?.binding?.target?.launch
  if (!target || !job.executionStopResult?.targets.some(value =>
    ['closed', 'already_closed'].includes(value.outcome) && same(value.launch, target))) return false
  job.stopped = true
  job.controller?.abort()
  await finishExecution(job, 'interrupted')
  return true
}

export function applyExecutionCancellation(job, error) {
  if (job.receipt || error?.effect !== 'not_started' || !job.executionStopResult) return
  const record = job.execution?.record
  const source = record?.source.status === 'verified' ? record.source.point?.launch : null
  const expected = job.execution?.reservation.target
  const target = expected?.expected_launch_id ? { session_id: expected.session_id, launch_id: expected.expected_launch_id } : null
  if (job.executionStopResult.targets.some(value => ['closed', 'already_closed'].includes(value.outcome)
    && (same(value.launch, source) || same(value.launch, target)))) job.stopped = true
}

export function interruptExecutions(transport, bots) {
  if (transport.executionStopping) return Promise.reject(unknown())
  const roots = [...new Map(bots.map(bot => [bot.id, bot])).values()]
  const jobs = [...new Set([...transport.jobs, ...transport.active.values()])]
  const rootIds = new Set(roots.map(bot => bot.id))
  for (const bot of roots) transport.stopVersions.set(bot.id, (transport.stopVersions.get(bot.id) ?? 0) + 1)
  const closing = Promise.resolve().then(async () => {
    const reads = new Map(), expected = new Map()
    const legacyGaps = new Set(transport.uncertainChanges.keys())
    const gapSessions = new Map([...legacyGaps].map(id => [id,
      transport.stopSessions.get(id) ?? transport.sessions.get(id) ?? jobs.find(job => job.bot.id === id)?.bot.session ?? roots.find(bot => bot.id === id)?.session ?? id]))
    const captureLegacy = () => {
      for (const id of transport.uncertainChanges.keys()) {
        legacyGaps.add(id)
        if (!gapSessions.has(id)) gapSessions.set(id, transport.stopSessions.get(id) ?? transport.sessions.get(id)
          ?? jobs.find(job => job.bot.id === id)?.bot.session ?? roots.find(bot => bot.id === id)?.session ?? id)
      }
      for (const [id, pending] of transport.sessionChanges) {
        const unbound = [...pending].find(value => !value.executionBound && value.executionIssued !== false)
        if (unbound) { legacyGaps.add(id); gapSessions.set(id, unbound.executionSession ?? transport.sessions.get(id) ?? id) }
      }
    }
    captureLegacy()
    try {
      // Dispatch promises include queues/preflight, not just native issuance.
      // Send stop first; Aiterm cancels preparing and drains actual issuance.
      for (const bot of roots) {
        try {
          const read = await transport.executionBridge.roots(transport.session(bot))
          reads.set(bot.id, read)
          for (const root of read.roots) expected.set(JSON.stringify(root), root)
        } catch { reads.set(bot.id, null) }
      }
      const result = expected.size ? await transport.executionBridge.stop([...expected.values()]) : null
      captureLegacy()
      // Idle restart/configuration preparations are not jobs. Invalidate their
      // captured version too when the stop reaches that exact session slot.
      const reachedBots = new Set()
      for (const [id, session] of transport.stopSessions) if (result?.targets.some(target => target.launch.session_id === session)) {
        reachedBots.add(id)
        if (!rootIds.has(id)) transport.stopVersions.set(id, (transport.stopVersions.get(id) ?? 0) + 1)
        if (result.targets.some(target => target.launch.session_id === session && target.outcome === 'unknown'))
          transport.uncertainChanges.set(id, 'agent_stop')
      }
      for (const target of result?.targets ?? []) if (target.outcome === 'unknown') {
        for (const bot of [...roots, ...jobs.map(job => job.bot)])
          if (transport.session(bot) === target.launch.session_id) transport.uncertainChanges.set(bot.id, 'agent_stop')
      }
      const confirmed = result?.targets.filter(target => ['closed', 'already_closed'].includes(target.outcome)).map(target => target.launch) ?? []
      const confirmedBots = new Set()
      for (const job of jobs) {
        job.executionStopResult = result
        const stopped = await applyExecutionStop(job)
        const unsentRoot = rootIds.has(job.bot.id) && !job.receipt && !job.execution?.issued.size
          && reads.get(job.bot.id)?.roots.some(root => confirmed.some(launch => same(launch, root)))
        if (!stopped && !unsentRoot) continue
        confirmedBots.add(job.bot.id)
        if (!stopped) {
          job.stopped = true; job.controller?.abort()
          await finishExecution(job, 'not_sent')
        }
      }
      for (const botId of confirmedBots) {
        if (!rootIds.has(botId) && !reachedBots.has(botId)) transport.stopVersions.set(botId, (transport.stopVersions.get(botId) ?? 0) + 1)
        transport.watches.get(botId)?.end()
        await transport.removeRetainedImages(botId)
      }
      captureLegacy()
      const affectedLegacy = [...legacyGaps].filter(id => rootIds.has(id)
        || result?.targets.some(target => target.launch.session_id === gapSessions.get(id)))
      for (const id of affectedLegacy) transport.uncertainChanges.set(id, 'legacy_change_pending')
      const unconfirmedBotIds = roots.filter(bot => {
        const read = reads.get(bot.id)
        // A read may lack a run boundary that the subsequent confirmed closure
        // resolves. Use the final stop coverage; an unknown/missing root itself
        // must still remain unconfirmed.
        return !read?.roots.length || read.observation === 'unknown' || result?.status !== 'stopped'
          || affectedLegacy.length > 0
          || read.roots.some(root => !confirmed.some(launch => same(launch, root)))
      }).map(bot => bot.id)
      return { unconfirmedBotIds, cascade: result }
    } catch (cause) {
      if (expected.size && cause?.effect !== 'not_started')
        for (const bot of roots) transport.uncertainChanges.set(bot.id, 'agent_stop')
      throw unknown(cause)
    }
    finally {
      // A failed stop does not discard a successful late send/done receipt.
      for (const job of jobs) if (!job.stopped && job.receipt) job.stopRequested = false
    }
  })
  closing.rootIds = rootIds
  transport.executionStopping = closing
  for (const job of jobs) if (rootIds.has(job.bot.id)) { job.stopRequested = true; job.interruption = closing }
  const clear = () => {
    if (transport.executionStopping === closing) transport.executionStopping = null
    transport.emitQueue()
  }
  closing.then(clear, clear)
  return closing
}
