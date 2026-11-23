// a532b4 stage 3 (terminals README "Terminals on Aiterm's generic remote surface"): the known_hosts file of one terminal for Aiterm's
// `remote.ssh.known_hosts_file`, written as UID1000 under /tmp (public lines; the file name carries the trust revision). Rewritten from the
// copy at every target (tmp, then mv), never reused by name: a file another user planted would pin the wrong host key (Epinel, #2422). The
// directory must be this user's own and mode 700. Lost with the container, rewritten on the next target.
import { createHash } from 'node:crypto'

export const TRUST_ROOT = '/tmp/bellteam-terminals/trust'
const SAFE = /^[a-z0-9][a-z0-9-]{0,62}$/
const failure = code => Object.assign(new Error(code), { code })

export const trustFilePath = (terminalId, revision, root = TRUST_ROOT) =>
  `${root}/${typeof terminalId === 'string' && SAFE.test(terminalId) ? terminalId : createHash('sha256').update(String(terminalId)).digest('hex').slice(0, 32)}.${String(revision).replace(/^sha256:/, '').slice(0, 16)}.known_hosts`

export function createTrustFile({ run, root = TRUST_ROOT }) {
  const sh = (script, path, options) => run('/bin/sh', ['-c', script, 'sh', path], { acceptNonzero: true, maxBuffer: 65536, ...options })
  return {
    async ensure({ terminalId, revision, lines }) {
      if (!/^sha256:[0-9a-f]{64}$/.test(revision ?? '') || !Array.isArray(lines) || !lines.length || lines.some(line => typeof line !== 'string' || /[\r\n]/.test(line))) throw failure('TRUST_FILE_INVALID')
      const path = trustFilePath(terminalId, revision, root)
      const written = await sh('umask 077 && mkdir -p "$(dirname "$1")" && [ "$(stat -c %u,%a "$(dirname "$1")" 2>/dev/null)" = "$(id -u),700" ] && cat > "$1.tmp" && mv -f "$1.tmp" "$1"', path, { input: `${lines.join('\n')}\n` })
      if (written.code !== 0) throw failure('TRUST_FILE_FAILED')
      return path
    }
  }
}
