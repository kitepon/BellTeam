// Terminal ssh keys through the 認証仲介 module's ssh agent (Owner 2026-11-28, docs terminal-keys-module-agent-20261128.md): no key is ever loaded into
// Aiterm or this parent. One long-lived command per body, `auth ssh fox,macbook,rabbit -- <holder script>`, run as the seat user from the operator Bot's folder
// (the module identifies the caller by its working folder; Sakura's grants "sshkey fox|macbook|rabbit sign" name that seat). The module serves an agent on
// /dev/shm/auth-XXXX/agent.sock for as long as the command runs; the script repoints ONE stable symlink at it, which is the `identity_agent` of every pinned
// remote call and of Aiterm's forward keeper (it never re-reads a path, so the path must not change when the holder restarts).
export const TERMINAL_KEY_OPERATOR = 'bot-09e6225c'
export const TERMINAL_AGENT_PATH = '/tmp/bellteam-terminals/agent/module.sock'
export const AUTH_CLIENT = '/srv/bellteam/shared/tools/auth-mediation/bin/auth'
// terminalId -> the module's key name (item "sshkey <name>"); the only terminals this reader owns.
export const TERMINAL_KEYS = Object.freeze({ 'fox-windows': 'fox', macbook: 'macbook', 'rabbit-linux': 'rabbit' })
// $1 = the symlink (its folder is made here: a fresh container has no /tmp/bellteam-terminals, live 11/28 Z238). Repoint atomically, drop it on exit only while it is still ours (a restarted holder may already own it).
const HOLDER_SCRIPT = 'mkdir -p -m 700 "$(dirname "$1")" && ln -sf "$SSH_AUTH_SOCK" "$1.$$" && mv -Tf "$1.$$" "$1" || exit 1; '
  + 'trap \'[ "$(readlink "$1")" = "$SSH_AUTH_SOCK" ] && rm -f "$1"; exit 0\' TERM INT; while :; do sleep 600 & wait $!; done'
const RESTART_FIRST_MS = 2000, RESTART_MAX_MS = 30_000, HEALTHY_MS = 60_000, FRESH_MS = 15_000, RETRY_MS = 3000

export function createTerminalKeyHolder({ run, keys = TERMINAL_KEYS, path = TERMINAL_AGENT_PATH, auth = AUTH_CLIENT, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), report = () => {} }) {
  const control = new AbortController()
  let supervised = null, listing = null, checked = null
  const holderNames = [...new Set(Object.values(keys))].join(',')

  const emitReport = payload => { try { Promise.resolve(report(payload)).catch(() => {}) } catch {} }

  // Restart on every exit with a backoff (a module restart does not end the holder; a container restart does). Nothing waits for a person.
  async function supervise() {
    let delay = 0
    while (!control.signal.aborted) {
      const startedAt = now()
      try { await run(auth, ['ssh', holderNames, '--', '/bin/sh', '-c', HOLDER_SCRIPT, 'terminal-key-holder', path], { signal: control.signal, maxBuffer: 64 * 1024 }) }
      catch (error) { if (!delay) emitReport({ code: 'TERMINAL_KEY_HOLDER_EXITED', reason: String(error?.code ?? error?.message ?? 'EXIT').slice(0, 80) }) }
      if (control.signal.aborted) return
      checked = null
      delay = now() - startedAt > HEALTHY_MS ? RESTART_FIRST_MS : Math.min(RESTART_MAX_MS, delay ? delay * 2 : RESTART_FIRST_MS)
      await sleep(delay)
    }
  }

  // The key names the agent lists now: one `ssh-add -l` on the stable path, shared by concurrent callers, fresh for 15 s (3 s while empty).
  function names() {
    if (checked && now() - checked.at < (checked.names.size ? FRESH_MS : RETRY_MS)) return Promise.resolve(checked.names)
    listing ??= (async () => {
      const found = new Set()
      try {
        const { stdout } = await run('/usr/bin/env', [`SSH_AUTH_SOCK=${path}`, 'ssh-add', '-l'], { acceptNonzero: true, maxBuffer: 64 * 1024, signal: AbortSignal.timeout(10_000) })
        for (const line of String(stdout).split('\n')) { const name = /\s(\S+)\s+\([A-Za-z0-9-]+\)\s*$/u.exec(line)?.[1]; if (name) found.add(name) }
      } catch { /* no agent, no key: availability is false until the holder is back */ }
      checked = { at: now(), names: found }
      return found
    })().finally(() => { listing = null })
    return listing
  }

  const port = {
    owns: terminalId => Object.hasOwn(keys, terminalId),
    // Never throws. The holder starts on first use too, so a reader built without start() still works.
    async available(terminalId) {
      port.start()
      return { available: port.owns(terminalId) && (await names()).has(keys[terminalId]), revision: 1 }
    },
    // The stable symlink, the same for every owned terminal; read on every call by terminals.
    agentSocket(terminalId) {
      if (!port.owns(terminalId)) throw Object.assign(new Error('KEY_NOT_MEDIATED'), { code: 'KEY_NOT_MEDIATED' })
      return path
    },
    start() { supervised ??= supervise().catch(error => emitReport({ code: 'TERMINAL_KEY_HOLDER_FAILED', reason: String(error?.code ?? error?.message).slice(0, 80) })); return supervised },
    stop() { control.abort() },
  }
  return port
}
