// P5 Seat entry contract of the 決裁箱拡張 module (docs/architecture/modules/approval-box-extension/seats-on-hosted-daemon.md, section 1): the MCP and hook entry the seats need,
// published as a FILE at <state>/approval-box-extension/harness-entries.json (schema bellteam.harness-entries.v1) because the body's boot registration pass runs before any module child is up.
// Content = what the seats' installed Approval Box runtime prints for `harness-entries --json` (P6), so it names the runtime the seats really run (pc.5 after install-runtime).
// Refreshed at start and every minute: a seat that installs a new runtime is picked up within a minute, then Molly's registration pass writes it. Nothing is written when the content is unchanged,
// and an unreadable or invalid answer keeps the last file (a seat's own entries are never cleared by a failed read).
import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const ENTRIES_SCHEMA = 'bellteam.harness-entries.v1'
const CALL_MS = 5000

const valid = value => value && typeof value === 'object' && !Array.isArray(value) && value.schema === ENTRIES_SCHEMA && value.product === 'approval-box'
  && typeof value.version === 'string' && value.mcpServers && typeof value.mcpServers === 'object'

export function createSeatEntryPublisher({ file, seatHome = process.env.APPROVAL_BOX_SEAT_HOME ?? '/home/bell', run = execFile, intervalMs = 60000, setTimer = setInterval, clearTimer = clearInterval }) {
  const read = () => new Promise(resolve => run(join(seatHome, '.approval-box', 'bin', 'approval-box'), ['harness-entries', '--json'],
    { timeout: CALL_MS, env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: seatHome } }, (error, stdout) => {
      if (error) return resolve(null)
      try { const value = JSON.parse(String(stdout)); resolve(valid(value) ? value : null) } catch { resolve(null) }
    }))
  let timer = null, busy = false
  async function publish() {
    if (busy) return { ok: false, changed: false, reason: 'busy' }
    busy = true
    try {
      const value = await read()
      if (!value) return { ok: false, changed: false, reason: 'unreadable' }
      const text = JSON.stringify(value, null, 2) + '\n'
      if (await readFile(file, 'utf8').catch(() => null) === text) return { ok: true, changed: false, version: value.version }
      await mkdir(dirname(file), { recursive: true, mode: 0o755 })
      const temp = `${file}.${process.pid}.tmp`
      await writeFile(temp, text, { mode: 0o644 }); await chmod(temp, 0o644)
      await rename(temp, file)
      return { ok: true, changed: true, version: value.version }
    } catch { return { ok: false, changed: false, reason: 'write_failed' } }
    finally { busy = false }
  }
  return {
    publish,
    start() { if (timer) return; void publish(); timer = setTimer(() => { void publish() }, intervalMs); timer?.unref?.() },
    close() { if (timer) { clearTimer(timer); timer = null } },
  }
}
