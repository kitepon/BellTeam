// Parent side of the usage child's cli.probe / cli.install effects (a451, runtime/user-cli-place.md).
// The child names only a harness; the vendor commands are this table and nothing else, because a child-sent command or URL
// would run arbitrary code as the seat user. Installers are the vendors' own latest, unmodified. No output, path or token returns.
import { join } from 'node:path'
import { createUserPlaceRunner, userPlace } from './seat-process.mjs'

const fail = (code, status = 502) => Object.assign(new Error(code), { code, status })
export const CLI_PROBE_MS = 10_000
export const CLI_INSTALL_MS = 600_000

// harness -> the command a seat user would run to find it, and the vendor's official install.
const VENDORS = Object.freeze({
  // npm 12 skips install scripts that are not allowed; claude-code's postinstall puts the native binary in place (a451x, Rapi 2026-11-19).
  claude: { bin: 'claude', install: place => ['npm', ['install', '--global', '--prefix', place, '--allow-scripts=@anthropic-ai/claude-code', '@anthropic-ai/claude-code@latest']] },
  codex: { bin: 'codex', install: place => ['npm', ['install', '--global', '--prefix', place, '@openai/codex@latest']] },
  grok: { bin: 'grok', install: () => ['bash', ['-c', 'set -euo pipefail; curl -fsSL https://x.ai/cli/install.sh | bash; install -d "$HOME/.local/bin"; install -m 0755 "$HOME/.grok/bin/grok" "$HOME/.local/bin/grok"']] },
  cursor: { bin: 'cursor-agent', install: () => ['bash', ['-c', 'set -euo pipefail; curl -fsSL https://cursor.com/install | bash']] },
})
export const CLI_HARNESSES = Object.freeze(Object.keys(VENDORS))

const NETWORK = /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|Could not resolve host|Failed to connect|Connection (?:timed out|refused|reset)|curl: \((?:6|7|28|35|52|56)\)/u
const VERSION = /\d+\.\d+\.\d+[0-9A-Za-z.+-]*/u

export function createCliEffects({ run = createUserPlaceRunner(), place = userPlace() } = {}) {
  const harness = value => { if (!Object.hasOwn(VENDORS, value)) throw fail('CLI_INSTALL_UNSUPPORTED', 400); return VENDORS[value] }
  const timed = (ms, work) => {
    const control = new AbortController()
    const timer = setTimeout(() => control.abort(), ms)
    return work(control.signal).finally(() => clearTimeout(timer))
  }
  // The whole answer is booleans and a version: a path decides user or image, then is dropped.
  const probe = async name => {
    const { bin } = harness(name)
    let result
    try {
      result = await timed(CLI_PROBE_MS, signal => run('sh', ['-c', 'p=$(command -v "$1") || exit 3; echo "$p"; "$p" --version 2>&1', 'probe', bin],
        { signal, acceptNonzero: true, maxBuffer: 65_536 }))
    } catch { return { installed: false, version: null, source: null } }
    const [found, ...rest] = result.stdout.split('\n')
    const version = rest.join('\n').match(VERSION)?.[0] ?? null
    if (result.code !== 0 || result.signal || !found || !version) return { installed: false, version: null, source: null }
    return { installed: true, version, source: found.startsWith(`${place}/`) ? 'user' : 'image' }
  }
  // One install at a time inside the parent, whatever the child does.
  let tail = Promise.resolve()
  const install = async name => {
    const { bin, install: command } = harness(name)
    const work = tail.then(async () => {
      const [executable, args] = command(place)
      let result
      try {
        result = await timed(CLI_INSTALL_MS, signal => run(executable, args, { signal, acceptNonzero: true, maxBuffer: 1_048_576 }))
      } catch (error) {
        throw fail(error?.code === 'ABORT_ERR' ? 'CLI_INSTALL_TIMEOUT' : 'CLI_INSTALL_FAILED')
      }
      if (result.code !== 0 || result.signal) throw fail(NETWORK.test(result.stderr) ? 'CLI_INSTALL_NETWORK' : 'CLI_INSTALL_FAILED')
      const seen = await probe(name)
      // An install that exited 0 but does not run would shadow a working image CLI (the user place is first on PATH): remove its entry.
      if (!seen.installed) await run('rm', ['-f', join(place, 'bin', bin)], { acceptNonzero: true, maxBuffer: 65_536 }).catch(() => {})
      if (!seen.installed || seen.source !== 'user') throw fail('CLI_INSTALL_FAILED')
      return { version: seen.version }
    })
    tail = work.catch(() => {})
    return work
  }
  return { probe, install, place: join(place) }
}
