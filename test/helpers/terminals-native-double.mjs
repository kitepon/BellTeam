// Test double for the terminals connection port and the C3/C5 ports it consumes.
// Execution tests can use `fakeConnection()` as terminals.connection; terminals tests use the native/secrets doubles.

// Shape of remote-process.mjs over Elegg's aiterm-remote-terminal (transient: reachability and C8 only).
export function fakeNative({ connectError, versions = ['1.0.0', '1.0.1'], updateCode = 0, trustRevision = `sha256:${'b'.repeat(64)}` } = {}) {
  const calls = []
  const sessions = []
  const trust = { provider: 'aiterm.known-hosts.v1', revision: trustRevision }
  const native = {
    calls,
    sessions,
    connectError,
    async trust(ref) { calls.push({ op: 'trust', ref }); return trust },
    async loadCredential({ key, ...request }) { calls.push({ op: 'loadCredential', ...request, keyLength: key.length }) },
    async register(target) { calls.push({ op: 'register', target }); return 'd1b2c3d4-1234-4234-8234-123456789abc' },
    // Self-service (Elegg accepted contract 2026-11-10); tests replace these to inject outcomes.
    async provision(request) { calls.push({ op: 'provision', ...request }); return { result: 'PROVISIONED' } },
    async authorizeKey({ password, ...request }) { calls.push({ op: 'authorizeKey', ...request, passwordLength: password.length }); return { schema: 'aiterm.remote-key-authorization.v1', ref: request.ref, result: 'AUTHORIZED' } },
    pathResult: (op, { path }) => ({ op, exists: true, directory: true, writable: true }),
    listResult: ({ path = '/Users/kite' } = {}) => ({ op: 'list_dirs', home: '/Users/kite', path, entries: [{ name: 'BellTeam' }, { name: 'Developer' }], truncated: false }),
    async confirmHostKey(ref, fingerprint) { calls.push({ op: 'confirmHostKey', ref, fingerprint }); return trust },
    async connect(request) {
      calls.push({ op: 'open', ...request })
      if (native.connectError) throw native.connectError
      let version = 0
      const session = {
        closed: false,
        async command(op, args) {
          calls.push({ op: 'command', command: op, ...(args ? { args } : {}) })
          if (op === 'path_status' || op === 'make_dir') return native.pathResult(op, args)
          if (op === 'list_dirs') return native.listResult(args)
          if (op !== 'claude_version') return { op, exit_code: updateCode, version: null, output_tail: '' }
          return { op, exit_code: 0, version: versions[Math.min(version++, versions.length - 1)], output_tail: '' }
        },
        async close() { session.closed = true; calls.push({ op: 'close' }); return { closed: true } }
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
    },
    credential(handle, context) {
      calls.push({ handle, context, op: 'credential' })
      return { handle, revision: 2, available: !unavailable }
    }
  }
}

// Stand-in for terminals.connection with the same target/observe/onAvailable surface.
export function fakeConnection({ targetError, accountOwner = 'owner' } = {}) {
  const listeners = new Set()
  const calls = []
  const observed = []
  return {
    calls,
    async target(request) {
      calls.push(request)
      if (targetError) throw Object.assign(new Error(targetError), { code: targetError, effect: 'not_started' })
      return { terminal: { ref: `binding-${request.terminalId}`, target: { host: '192.168.1.12', user: 'kite', port: 22 }, trustRevision: `sha256:${'a'.repeat(64)}`, credentialRevision: 3 }, cwd: request.projectRoot, accountOwner }
    },
    observed,
    observe(terminalId) { observed.push(terminalId) },
    onAvailable(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    emitAvailable(terminalId) { for (const listener of listeners) listener({ terminalId }) }
  }
}
