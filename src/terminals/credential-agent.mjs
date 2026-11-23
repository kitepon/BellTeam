// a532b4 stage 2 (terminals README "Stage 2"): one ssh-agent per terminal, started and fed as UID1000 through the seat process
// runner. The key bytes go only to `ssh-add -` on stdin: never argv, env, a file or a log, and an error keeps only its code.
import { createHash } from 'node:crypto'

export const AGENT_ROOT = '/tmp/bellteam-terminals/agent'
const SAFE = /^[a-z0-9][a-z0-9-]{0,62}$/
const failure = code => Object.assign(new Error(code), { code })

// The registry's terminalId is a lowercase slug; anything else is hashed so the path never carries a separator or an odd name.
export const socketPath = (terminalId, root = AGENT_ROOT) =>
  `${root}/${typeof terminalId === 'string' && SAFE.test(terminalId) ? terminalId : createHash('sha256').update(String(terminalId)).digest('hex').slice(0, 32)}.sock`

export function createCredentialAgent({ run, root = AGENT_ROOT }) {
  // The runner takes no environment: the socket is the one argument of a fixed script.
  const sh = (script, socket, options) => run('/bin/sh', ['-c', script, 'sh', socket], { acceptNonzero: true, maxBuffer: 65536, ...options })
  const live = async socket => { const { code } = await sh('SSH_AUTH_SOCK="$1" exec ssh-add -l >/dev/null 2>&1', socket); return code === 0 || code === 1 } // 2 = no agent

  // Epinel (#2421): never trust a socket in a directory another user could have made. Ours is this user's own, mode 700.
  const owned = async socket => (await sh('[ "$(stat -c %u,%a "$(dirname "$1")" 2>/dev/null)" = "$(id -u),700" ]', socket)).code === 0

  async function ensure(terminalId) {
    const socket = socketPath(terminalId, root)
    if ((await owned(socket)) && await live(socket)) return socket
    const made = await sh('umask 077 && mkdir -p "$(dirname "$1")" && rm -f "$1" && exec ssh-agent -a "$1" >/dev/null 2>&1', socket)
    if (made.code !== 0 || !(await owned(socket)) || !(await live(socket))) throw failure('AGENT_START_FAILED')
    return socket
  }

  return {
    socketPath: terminalId => socketPath(terminalId, root),
    // A newer revision replaces the loaded identity (delete all, then add), so exactly one key is held.
    async load(terminalId, key) {
      if (typeof key !== 'string' || !key) throw failure('CREDENTIAL_UNUSABLE')
      const socket = await ensure(terminalId)
      await sh('SSH_AUTH_SOCK="$1" exec ssh-add -D >/dev/null 2>&1', socket)
      const added = await sh('SSH_AUTH_SOCK="$1" exec ssh-add - >/dev/null 2>&1', socket, { input: key })
      if (added.code !== 0) throw failure('AGENT_LOAD_FAILED')
    },
    // True while the agent answers and holds an identity (ssh-add -l exit 0); read by the switch decision.
    async held(terminalId) {
      const socket = socketPath(terminalId, root)
      return (await owned(socket)) && (await sh('SSH_AUTH_SOCK="$1" exec ssh-add -l >/dev/null 2>&1', socket)).code === 0
    },
    // Removal: delete the keys, leave the socket path (an idle agent costs nothing and the path stays stable).
    async clear(terminalId) {
      const socket = socketPath(terminalId, root)
      if (await live(socket)) await sh('SSH_AUTH_SOCK="$1" exec ssh-add -D >/dev/null 2>&1', socket)
    }
  }
}
