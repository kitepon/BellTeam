// Only lifecycle recovery is retried; accepted business requests are never replayed.
export function createModuleChildRestart(restart, component = null, onModuleRestartLimit) {
  let timer = null, closed = false, delay = 1000, healthySince = null, attempting = false, state = null
  let quietTimer = null, reported = false, attempts = [], lastExit = { code: null, signal: null }, lastReason = 'recovery_failed'
  const emit = value => { try { Promise.resolve(onModuleRestartLimit?.(value)).catch(() => {}) } catch {} }
  const clearQuiet = () => { clearTimeout(quietTimer); quietTimer = null }
  const quiet = () => {
    if (quietTimer || !reported || closed || healthySince === null) return
    quietTimer = setTimeout(() => {
      quietTimer = null
      if (closed || healthySince === null || Date.now() - healthySince < 1_800_000) return
      reported = false; attempts = []
      emit({ kind: 'module_restart_limit', moduleId: component, cleared: true })
    }, Math.max(1, 1_800_000 - (Date.now() - healthySince)))
    quietTimer.unref?.()
  }
  const waiters = new Set()
  const wake = () => { for (const resolve of waiters) resolve(); waiters.clear() }
  const transition = next => {
    if (state === next) return
    state = next
    if (component) try { console.error(JSON.stringify({ code: 'MODULE_LIFECYCLE_STATE', component, state: next })) } catch {}
  }
  const schedule = () => {
    if (closed || timer || attempting) return
    timer = setTimeout(async () => {
      timer = null
      if (closed) return
      attempting = true
      try { await restart() }
      catch (error) { lastReason = error?.code === 'READY_TIMEOUT' ? 'ready_timeout' : error?.code === 'READY_PROBE_FAILED' ? 'ready_probe_failed' : 'recovery_failed' }
      finally {
        delay = Math.min(30000, delay * 2)
        attempting = false
        if (healthySince === null) schedule()
      }
    }, delay)
    timer.unref?.()
  }
  return {
    running() { healthySince ??= Date.now(); clearTimeout(timer); timer = null; quiet(); transition('available'); wake() },
    lost(error) {
      if (closed) return
      clearQuiet()
      if (error?.code === 'READY_TIMEOUT') lastReason = 'ready_timeout'
      else if (error?.code === 'READY_PROBE_FAILED') lastReason = 'ready_probe_failed'
      if (healthySince !== null && Date.now() - healthySince >= 60000) delay = 1000
      healthySince = null
      transition('backoff')
      schedule()
    },
    restarting() {
      if (closed || !attempting) return
      attempts = attempts.filter(at => Date.now() - at < 1_800_000)
      attempts.push(Date.now())
      if (!reported && attempts.length >= 5 && component) {
        reported = true
        emit({ kind: 'module_restart_limit', moduleId: component, count: attempts.length, windowSeconds: 1800,
          lastExit: { ...lastExit }, lastReason })
      }
      if (attempts.length > 5) attempts.shift()
    },
    exited({ code, signal }) {
      lastExit = { code: Number.isInteger(code) && code >= -2147483648 && code <= 2147483647 ? code : null,
        signal: childSignals.includes(signal) ? signal : null }
      lastReason = 'process_exit'
    },
    wait: () => state === 'available' || closed ? Promise.resolve() : new Promise(resolve => waiters.add(resolve)),
    close() { closed = true; clearTimeout(timer); clearQuiet(); timer = null; transition('closed'); wake() },
  }
}

const childCodes = ['ERR_IPC_CHANNEL_CLOSED', 'ERR_OUT_OF_RANGE', 'ERR_WORKER_OUT_OF_MEMORY', 'ERR_MODULE_NOT_FOUND']
const childSignals = ['SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT', 'SIGKILL', 'SIGPIPE', 'SIGQUIT', 'SIGSEGV', 'SIGTERM']
const exitOrigins = ['peer_failure', 'parent_disconnect', 'exit_control', 'exit_writer_control']
const exitFailureCodes = ['IPC_INVALID', 'IPC_DISCONNECTED', 'IPC_TIMEOUT', 'IPC_ACK_TIMEOUT', 'IPC_SEND_FAILED',
  'CHILD_EXITED', 'BACKGROUND_UNCONFIRMED', 'DELIVERY_RELEASE_UNCONFIRMED', 'PROTOCOL_UNCONFIRMED'].map(code => `CONVERSATION_${code}`)
// shortcut: only known Node OOM/GC formats, extend when a new runtime format is observed.
const heapMarkers = ['FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
  'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory',
  'FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory']
const gcLine = /\b(?:Mark-Compact|Mark-sweep|Scavenge)(?: \(reduce\))?\s+(\d+(?:\.\d+)?)\s+\((\d+(?:\.\d+)?)\)\s+->\s+(\d+(?:\.\d+)?)\s+\((\d+(?:\.\d+)?)\)\s+MB,\s+(?:pooled:\s+\d+(?:\.\d+)?\s+MB,\s+)?(\d+(?:\.\d+)?)\s*\/\s*\d+(?:\.\d+)?\s+ms\b/

export function observeModuleChild(child) {
  let pending = Buffer.alloc(0), stderrBytes = 0, stderrTruncated = false, heap = false, closed = false
  let childExitOrigin = null, lineTruncated = false
  const codes = new Set(), evidence = []
  const append = entry => {
    evidence.push(entry)
    if (evidence.length > 8) { evidence.shift(); stderrTruncated = true }
  }
  const gc = line => {
    const match = gcLine.exec(line)
    if (!match) return
    const [beforeMiB, afterMiB, capacityMiB, pauseMs] = [match[1], match[3], match[4], match[5]].map(Number)
    if ([beforeMiB, afterMiB, capacityMiB, pauseMs].every(value => Number.isFinite(value) && value >= 0 && value <= 1e9))
      append({ kind: 'gc', beforeMiB, afterMiB, capacityMiB, pauseMs })
  }
  const scan = (line, complete) => {
    if (complete && !lineTruncated && !childExitOrigin && line.length <= 1024) {
      try {
        const value = JSON.parse(line)
        if (value && Object.keys(value).sort().join(',') === 'code,failureCode,origin'
          && value.code === 'CONVERSATION_CHILD_EXIT_ORIGIN' && exitOrigins.includes(value.origin)
          && (value.failureCode === null || exitFailureCodes.includes(value.failureCode)))
          childExitOrigin = { origin: value.origin, failureCode: value.failureCode }
      } catch {}
    }
    for (const code of childCodes) if (line.includes(code)) codes.add(code)
    if (!heap && heapMarkers.some(marker => line.includes(marker))) { heap = true; append({ kind: 'heap_oom' }) }
    if (complete) gc(line)
  }
  child.stderr?.on('data', chunk => {
    if (closed) return
    const raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, stderrBytes + raw.length)
    if (stderrBytes > 8192) stderrTruncated = true
    // Scan every bounded window so a large data event cannot hide a marker in its middle.
    for (let offset = 0; offset < raw.length; offset += 4096) {
      const part = raw.subarray(offset, offset + 4096)
      if (pending.length + part.length > 8192) { pending = pending.subarray(-4096); stderrTruncated = true; lineTruncated = true }
      pending = Buffer.concat([pending, part])
      let start = 0, end
      while ((end = pending.indexOf(10, start)) >= 0) {
        scan(pending.subarray(start, end).toString('utf8'), true); start = end + 1; lineTruncated = false
      }
      pending = pending.subarray(start)
      scan(pending.toString('utf8'), false)
    }
  })
  const finish = () => {
    if (closed) return
    scan(pending.toString('utf8'), true); pending = Buffer.alloc(0); closed = true
  }
  child.stderr?.once('close', finish)
  child.once?.('close', finish)
  child.stdout?.resume(); child.stderr?.resume()
  return () => {
    if (child.stderr?.closed) finish()
    return { stderrCodes: [...codes], reason: heap ? 'heap_out_of_memory' : codes.has('ERR_WORKER_OUT_OF_MEMORY') ? 'worker_out_of_memory' : 'unknown',
      stderrBytes, stderrTruncated, stderrTail: evidence.map(entry => ({ ...entry })),
      childExitOrigin: childExitOrigin ? { ...childExitOrigin } : null }
  }
}

export function reportConversationChildExitOrigin(childSequence, observation) {
  try {
    const cause = observation.childExitOrigin
    console.error(JSON.stringify({ code: 'MODULE_CHILD_EXIT_ORIGIN', component: 'conversation',
      childSequence: Number.isSafeInteger(childSequence) && childSequence > 0 ? childSequence : null,
      observedAt: new Date().toISOString(), origin: cause?.origin ?? 'unknown', failureCode: cause?.failureCode ?? null }))
  } catch {}
}

export function reportModuleChildExit(component, { code, signal }, observation, onModuleChildExit) {
  const exitCode = Number.isInteger(code) && code >= -2147483648 && code <= 2147483647 ? code : null
  signal = childSignals.includes(signal) ? signal : null
  // The console stays fixed; only the closed numeric evidence DTO reaches diagnostics.
  console.error(JSON.stringify({ code: 'MODULE_CHILD_EXITED', component, stderrCodes: observation.stderrCodes, exitCode, signal }))
  if (typeof onModuleChildExit !== 'function') return
  try {
    const value = { schema: 'bellteam.module-child-exit.v1', component, exitCode, signal,
      stderrCodes: observation.stderrCodes, reason: observation.reason, stderrBytes: observation.stderrBytes,
      stderrTruncated: observation.stderrTruncated, stderrTail: observation.stderrTail,
      // The child's own closed exit-origin line (conversation only); absent when the child wrote none.
      ...(observation.childExitOrigin ? { childExitOrigin: { ...observation.childExitOrigin } } : {}) }
    Promise.resolve(onModuleChildExit(value)).catch(() => {})
  } catch {}
}
