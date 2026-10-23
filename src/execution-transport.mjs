// Execution registration stays in Aiterm. The immediate stop-button path below
// sends one session/batch request without waiting for the older proof adapter.
import { isDeepStrictEqual as same } from 'node:util'
import { confirmedSessionInterruption } from './session-interruption.mjs'
import { callExecutionRef, deliveryExecutionRef, roomExecutionRef } from './execution-bridge.mjs'

export { applyExecutionStop, applyExecutionCancellation, finishExecution } from './delivery-job.mjs'

const unknown = cause => Object.assign(new Error('停止を確認できませんでした。', { cause }), { code: 'BOT_STOP_UNCONFIRMED' })

// 停止操作の骨格。経路（停止ボタンの一括停止と、実行登録ごとの中断）で共通: 根のBotの停止世代を進め、
// 配送jobへ停止要求を付け、進行中の停止として公開し、終わったら止まらなかったjobを解放して一覧を更新する。
// 送り方と結果の読み方だけが経路ごとに違い、runが持つ。
function stopOperation({ sessionState, activity }, bots, run, { acceptedOnly = false } = {}) {
  const roots = [...new Map(bots.map(bot => [bot.id, bot])).values()]
  const rootIds = new Set(roots.map(bot => bot.id))
  const jobs = activity.stopTargets()
  for (const bot of roots) sessionState.invalidate(bot.id)
  const operation = run({ roots, rootIds, jobs }).finally(() => {
    for (const job of jobs) job.release({ acceptedOnly })
    if (sessionState.stopping === operation) sessionState.stopping = null
    activity.emit()
  })
  operation.rootIds = rootIds
  sessionState.stopping = operation
  for (const job of jobs) if (rootIds.has(job.bot.id)) job.requestStop(operation)
  return operation
}

export function sendStopOperations(seat, bots) {
  return stopOperation(seat, bots, ({ rootIds, roots, jobs }) => {
    // Start the actual stop RPC before any relation/status/disk read.
    let sent
    try { sent = seat.requestStop(roots.map(bot => seat.session(bot))) }
    catch (error) { sent = Promise.reject(error) }
    return Promise.resolve(sent).then(cascade => {
      const sentSessions = new Set(cascade.targets.filter(target => ['sent', 'idle'].includes(target.status)).map(target => target.session_id))
      for (const job of jobs) if (sentSessions.has(seat.session(job.bot))) job.markStopped()
      // Descendants can be BellTeam members too. Cancel only preparations that
      // existed when the owner clicked Stop; a new owner input is still allowed.
      seat.sessionState.invalidateReached(session => sentSessions.has(session), rootIds)
      const failed = cascade.targets.some(target => target.status === 'failed') || ['partial', 'failed'].includes(cascade.status)
      return { requestSent: true, cascade, unconfirmedBotIds: roots.filter(bot => failed || !sentSessions.has(seat.session(bot))).map(bot => bot.id) }
    })
  })
}

export async function reserveExecution({ observe, session, executionBridge }, job) {
  const observed = await observe(job.bot)
  if (observed?.schema !== 'aiterm.pty-observe-result.v1' || observed.session_id !== session(job.bot)
    || typeof observed.exists !== 'boolean' || (observed.exists ? !/^[0-9a-f]{32}$/u.test(observed.launch_id ?? '') : observed.launch_id !== null))
    throw unknown()
  const deliveryId = job.info.groupId ?? job.id
  const request = job.info.call
    ? callExecutionRef({ ...job.info.call, deliveryId }, observed.session_id)
    : (job.info.context === 'room' ? roomExecutionRef : deliveryExecutionRef)(deliveryId, observed.session_id)
  const source = job.executionSource?.source ?? { launch: null, boundary: null }
  job.execution = await executionBridge.reserve({
    request,
    sourceSession: job.executionSource?.sourceSession ?? null, source,
    targetSession: observed.session_id, expectedLaunch: observed.launch_id,
  }, { sourceContext: source.launch ? source : null })
  job.executionWasPresent = observed.exists
}

export async function dispatchExecution(seat, job, bot, message, images, { setupTest, check }) {
  check()
  const imageFiles = await seat.imageFiles(images)
  try {
    check()
    const execution = job.execution
    let session = seat.session(bot)
    if (!job.executionWasPresent) session = await seat.wake(bot, { setupTest, execution })
    check()
    const result = await execution.invoke('pty_send', { session_id: session, text: message, require_agent: true,
      ...(imageFiles.length ? { image: imageFiles.map(file => file.path) } : {}) }, { meta: { 'aiterm/caller': 'BellTeam' } })
    const receipt = result.structuredContent
    if (receipt?.mode !== 'agent_steer'
      && (receipt?.mode !== 'agent_dispatch' || !Number.isInteger(receipt.event_cursor) || !receipt.wait_process))
      throw unknown()
    return { receipt, result, imageFiles, session }
  } catch (error) {
    await seat.removeTemporaryImages(imageFiles)
    throw error
  }
}

export function interruptExecutions(seat, bots) {
  const { sessionState, session } = seat
  if (sessionState.stopping) return Promise.reject(unknown())
  return stopOperation(seat, bots, ({ roots, rootIds, jobs }) => Promise.resolve().then(async () => {
    const executionBridge = seat.executionBridge
    const reads = new Map(), expected = new Map()
    const legacyGaps = new Set(sessionState.uncertainChanges.keys())
    const knownSession = id => sessionState.stopSessions.get(id) ?? sessionState.sessions.get(id)
      ?? jobs.find(job => job.bot.id === id)?.bot.session ?? roots.find(bot => bot.id === id)?.session ?? id
    const gapSessions = new Map([...legacyGaps].map(id => [id, knownSession(id)]))
    const captureLegacy = () => {
      for (const id of sessionState.uncertainChanges.keys()) {
        legacyGaps.add(id)
        if (!gapSessions.has(id)) gapSessions.set(id, knownSession(id))
      }
      for (const [id, pending] of sessionState.sessionChanges) {
        const unbound = [...pending].find(value => !value.executionBound && value.executionIssued !== false)
        if (unbound) { legacyGaps.add(id); gapSessions.set(id, unbound.executionSession ?? sessionState.sessions.get(id) ?? id) }
      }
    }
    captureLegacy()
    try {
      // Dispatch promises include queues/preflight, not just native issuance.
      // Send stop first; Aiterm cancels preparing and drains actual issuance.
      for (const bot of roots) {
        try {
          const read = await executionBridge.roots(session(bot))
          reads.set(bot.id, read)
          for (const root of read.roots) expected.set(JSON.stringify(root), root)
        } catch { reads.set(bot.id, null) }
      }
      const result = expected.size ? await executionBridge.interrupt([...expected.values()]) : null
      captureLegacy()
      // Idle restart/configuration preparations are not jobs. Invalidate their
      // captured version too when the stop reaches that exact session slot.
      const reachedBots = sessionState.invalidateReached(value => result?.targets.some(target => target.launch.session_id === value) ?? false, rootIds)
      const confirmed = result?.targets.filter(confirmedSessionInterruption).map(target => target.launch) ?? []
      const confirmedBots = new Set()
      for (const job of jobs) {
        const stopped = await job.applyStopResult(result)
        const unsentRoot = rootIds.has(job.bot.id) && job.unsent
        if (!stopped && !unsentRoot) continue
        confirmedBots.add(job.bot.id)
        if (!stopped) {
          job.markStopped()
          await job.finishExecution('not_sent')
        }
      }
      // Self-turn watchers and retained images belong to a run; do not
      // clear every watcher/image for a preserved session by Bot ID.
      for (const botId of confirmedBots) if (!rootIds.has(botId) && !reachedBots.has(botId)) sessionState.invalidate(botId)
      captureLegacy()
      const affectedLegacy = [...legacyGaps].filter(id => rootIds.has(id)
        || result?.targets.some(target => target.launch.session_id === gapSessions.get(id)))
      for (const id of affectedLegacy) sessionState.uncertainChanges.set(id, 'legacy_change_pending')
      const unconfirmedBotIds = roots.filter(bot => {
        const read = reads.get(bot.id)
        // Only the final v2 receipt proves the interruption and preserved
        // session across the complete relation set. Empty roots remain unknown.
        return !read?.roots.length || read.observation === 'unknown' || result?.status !== 'confirmed'
          || affectedLegacy.length > 0
          || read.roots.some(root => !confirmed.some(launch => same(launch, root)))
      }).map(bot => bot.id)
      return { unconfirmedBotIds, cascade: result }
    } catch (cause) {
      // A missing key receipt is not a delayed close. Do not permanently
      // forbid new work in the same launch; Aiterm owns temporary run fences.
      throw unknown(cause)
    }
  }), { acceptedOnly: true })
}
