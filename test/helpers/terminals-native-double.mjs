// Test double for the terminals bound native port and the C3/C5 ports it consumes.
// Execution tests can use `fakeConnection()` as terminals.connection; terminals tests use the native/secrets doubles.

// Shape of the terminals native port over Elegg's aiterm-remote-terminal process (remote-process.mjs, f7022539).
export function fakeNative({ connectError, versions = ['1.0.0', '1.0.1'], updateCode = 0, trustRevision = `sha256:${'b'.repeat(64)}` } = {}) {
  const calls = []
  const sessions = []
  const trust = { provider: 'aiterm.known-hosts.v1', revision: trustRevision }
  const native = {
    calls,
    sessions,
    connectError,
    async trust(ref) { calls.push({ op: 'trust', ref }); return trust },
    async confirmHostKey(ref, fingerprint) { calls.push({ op: 'confirmHostKey', ref, fingerprint }); return trust },
    async connect(request) {
      calls.push({ op: 'open', ...request })
      if (native.connectError) throw native.connectError
      const listeners = new Set()
      let version = 0
      const session = {
        closed: false,
        async callTool(name, args, options) { calls.push({ op: 'callTool', name, args, options }); return { content: [{ type: 'text', text: '{}' }] } },
        transcript: { async read(request) { calls.push({ op: 'transcript', request }); return { entries: [], cursor: request?.cursor } } },
        async command(op) {
          calls.push({ op: 'command', command: op })
          if (op !== 'claude_version') return { op, exit_code: updateCode, version: null, output_tail: '' }
          return { op, exit_code: 0, version: versions[Math.min(version++, versions.length - 1)], output_tail: '' }
        },
        async close() { session.closed = true; calls.push({ op: 'close' }); return { closed: true } },
        onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        lose() { for (const listener of listeners) listener({ type: 'lost', at: new Date().toISOString(), code: 'CONNECTION_LOST' }) }
      }
      sessions.push(session)
      return session
    }
  }
  return native
}

export function fakeSecrets({ unavailable = false } = {}) {
  const calls = []
  return {
    calls,
    async withResolved(handle, context, consume) {
      calls.push({ handle, context })
      if (unavailable) throw Object.assign(new Error('unavailable'), { code: 'SECRET_UNAVAILABLE' })
      return consume({ nativeKeyRef: `native-${handle}`, revision: 3 })
    }
  }
}

// Stand-in for terminals.connection with the same open/close/onAvailable surface.
export function fakeConnection({ openError } = {}) {
  const listeners = new Set()
  const native = fakeNative()
  return {
    native,
    async open(request) {
      if (openError) throw Object.assign(new Error(openError), { code: openError, effect: 'not_started' })
      const session = await native.connect({ target: { terminalId: request.terminalId }, hostTrust: null, credential: null })
      return { connectionRef: `ref-${native.sessions.length}`, native: { callTool: session.callTool, transcript: session.transcript } }
    },
    async close() { return { closed: true } },
    onAvailable(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    emitAvailable(terminalId) { for (const listener of listeners) listener({ terminalId }) }
  }
}
