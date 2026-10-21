// Optional integration: supplied only after the Aiterm execution runtime is
// accepted. No live mount, relation graph, retry or legacy-close fallback here.
import { isDeepStrictEqual as same } from 'node:util'
import { deliveryExecutionRef, roomExecutionRef } from './execution-bridge.mjs'

const unknown = cause => Object.assign(new Error('停止を確認できませんでした。', { cause }), { code: 'BOT_STOP_UNCONFIRMED' })

export async function reserveExecution(transport, job) {
  const observed = await transport.observe(job.bot)
  if (observed?.schema !== 'aiterm.pty-observe-result.v1' || observed.session_id !== transport.session(job.bot)
    || typeof observed.exists !== 'boolean' || (observed.exists ? !/^[0-9a-f]{32}$/u.test(observed.launch_id ?? '') : observed.launch_id !== null))
    throw unknown()
  const ref = job.info.context === 'room' ? roomExecutionRef : deliveryExecutionRef
  const source = job.executionSource?.source ?? { launch: null, boundary: null }
  job.execution = await transport.executionBridge.reserve({
    request: ref(job.info.groupId ?? job.id, observed.session_id),
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

export function interruptExecutions(transport, bots) {
  if (transport.executionStopping) return Promise.reject(unknown())
  const roots = [...new Map(bots.map(bot => [bot.id, bot])).values()]
  const jobs = [...new Set([...transport.jobs, ...transport.active.values()])]
  const rootIds = new Set(roots.map(bot => bot.id))
  for (const bot of roots) transport.stopVersions.set(bot.id, (transport.stopVersions.get(bot.id) ?? 0) + 1)
  const closing = Promise.resolve().then(async () => {
    const reads = new Map(), expected = new Map()
    try {
      // Wait only issued dispatch/change calls, never a turn's idle/completion.
      await Promise.allSettled([...transport.dispatches.values(), ...transport.waking.values()])
      while (transport.sessionChanges.size)
        await Promise.allSettled([...transport.sessionChanges.values()].flatMap(set => [...set]))
      for (const bot of roots) {
        try {
          transport.requireSessionKnown(bot.id)
          const read = await transport.executionBridge.roots(transport.session(bot))
          reads.set(bot.id, read)
          for (const root of read.roots) expected.set(JSON.stringify(root), root)
        } catch { reads.set(bot.id, null) }
      }
      const result = expected.size ? await transport.executionBridge.stop([...expected.values()]) : null
      for (const target of result?.targets ?? []) if (target.outcome === 'unknown') {
        for (const bot of [...roots, ...jobs.map(job => job.bot)])
          if (transport.session(bot) === target.launch.session_id) transport.uncertainChanges.set(bot.id, 'agent_stop')
      }
      const confirmed = result?.targets.filter(target => ['closed', 'already_closed'].includes(target.outcome)).map(target => target.launch) ?? []
      const confirmedBots = new Set()
      for (const job of jobs) {
        const target = job.execution?.binding?.target?.launch
        const stopped = target && confirmed.some(launch => same(launch, target))
        const unsentRoot = rootIds.has(job.bot.id) && !job.receipt && !job.execution?.issued.size
          && reads.get(job.bot.id)?.roots.some(root => confirmed.some(launch => same(launch, root)))
        if (!stopped && !unsentRoot) continue
        confirmedBots.add(job.bot.id)
        job.stopped = true
        job.controller?.abort()
        await finishExecution(job, stopped ? 'interrupted' : 'not_sent')
      }
      for (const botId of confirmedBots) {
        if (!rootIds.has(botId)) transport.stopVersions.set(botId, (transport.stopVersions.get(botId) ?? 0) + 1)
        transport.watches.get(botId)?.end()
        await transport.removeRetainedImages(botId)
      }
      const unconfirmedBotIds = roots.filter(bot => {
        const read = reads.get(bot.id)
        // A read may lack a run boundary that the subsequent confirmed closure
        // resolves. Use the final stop coverage; an unknown/missing root itself
        // must still remain unconfirmed.
        return !read?.roots.length || read.observation === 'unknown' || result?.status !== 'stopped'
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
  transport.executionStopping = closing
  for (const job of jobs) if (rootIds.has(job.bot.id)) { job.stopRequested = true; job.interruption = closing }
  const clear = () => {
    if (transport.executionStopping === closing) transport.executionStopping = null
    transport.emitQueue()
  }
  closing.then(clear, clear)
  return closing
}
