// a451 (docs/architecture/modules/execution/cli-not-installed.md): is the AI CLI a launch needs there? Usage owns the fact
// (harnessCli.installed(), cached probe); execution never probes the filesystem. Not installed is a wait, never a failure.
const NAMES = { claude: 'Claude', codex: 'Codex', grok: 'Grok', cursor: 'Cursor' }
// Mika's sentences (2026-11-19), the same ones HarnessAuth refuses with. 'checking' ends by itself, so it has no notice.
const NOTICES = {
  not_installed: name => `${name}がまだ入っていません。AIの認証から入れてください`,
  installing: name => `${name}を入れています。終わるまでお待ちください`,
  failed: name => `${name}を入れられませんでした。AIの認証からもう一度入れてください`,
}
export const HARNESS_NOT_INSTALLED = 'HARNESS_NOT_INSTALLED'

// null: ready, or the window is absent / answers something unknown (unknown is not a reason to stop). Else { state, notice }.
export function harnessCliWait(port, harness) {
  let state
  try { state = port?.installed?.()?.[harness]?.state } catch { return null }
  if (state === 'checking') return { state, notice: null }
  return Object.hasOwn(NOTICES, state) ? { state, notice: NOTICES[state](NAMES[harness] ?? harness) } : null
}

// The existing "seat waits on its user" refusal (BOT_AWAITING_USER, 409, not_started): the receipt stays queued, no failed row, no filing.
export const harnessCliRefusal = (harness, wait) => Object.assign(new Error(wait.notice ?? `${NAMES[harness] ?? harness}を確かめています`),
  { code: 'BOT_AWAITING_USER', status: 409, effect: 'not_started', awaitingReason: HARNESS_NOT_INSTALLED, harnessCliState: wait.state })
