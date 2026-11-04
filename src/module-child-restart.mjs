// Only lifecycle recovery is retried; accepted business requests are never replayed.
export function createModuleChildRestart(restart) {
  let timer = null, closed = false, enabled = false, delay = 1000, healthySince = null, attempting = false
  const schedule = () => {
    if (closed || !enabled || timer || attempting) return
    timer = setTimeout(async () => {
      timer = null
      if (closed) return
      attempting = true
      try { await restart() }
      catch {}
      finally {
        delay = Math.min(30000, delay * 2)
        attempting = false
        if (healthySince === null) schedule()
      }
    }, delay)
    timer.unref?.()
  }
  return {
    running() { enabled = true; healthySince ??= Date.now() },
    lost() {
      if (healthySince !== null && Date.now() - healthySince >= 60000) delay = 1000
      healthySince = null
      schedule()
    },
    close() { closed = true; clearTimeout(timer); timer = null },
  }
}

export function observeModuleChild(child) {
  let tail = ''
  const codes = new Set()
  const known = ['ERR_IPC_CHANNEL_CLOSED', 'ERR_OUT_OF_RANGE', 'ERR_WORKER_OUT_OF_MEMORY', 'ERR_MODULE_NOT_FOUND']
  child.stderr?.on('data', chunk => {
    tail = (tail + Buffer.from(chunk).subarray(-512).toString('utf8')).slice(-1024)
    for (const code of known) if (tail.includes(code)) codes.add(code)
  })
  child.stdout?.resume(); child.stderr?.resume()
  return () => [...codes]
}

export function reportModuleChildExit(component, { code, signal }, stderrCodes = []) {
  // Only fixed error codes and OS metadata survive; arbitrary stderr text is discarded.
  console.error(JSON.stringify({ code: 'MODULE_CHILD_EXITED', component,
    stderrCodes, exitCode: Number.isInteger(code) ? code : null,
    signal: ['SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT', 'SIGKILL', 'SIGPIPE', 'SIGQUIT', 'SIGSEGV', 'SIGTERM'].includes(signal) ? signal : null }))
}
