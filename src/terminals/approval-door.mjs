// The launch side of the Approval Box door on a terminal (terminals README "Approval Box door on terminals", a532b1).
// terminals.connection returns `doorHook` beside the target; execution passes it to agent_launch unchanged, like `terminal`.
// Aiterm runs the hook on the host after every launch and resume of the seat (post_launch, aiterm-mcp >= 0.70.100).
import { readFileSync } from 'node:fs'

// 0.70.100 carries post_launch, the hook env and aiterm-session-alive (Elegg). Both Aiterms must have it: the container's schema
// refuses an unknown launch field, and an older terminal strips it silently (the door would never register).
export const DOOR_MIN_AITERM = '0.70.100'

const version = value => /^(\d+)\.(\d+)\.(\d+)/.exec(value ?? '')?.slice(1).map(Number) ?? null
export function atLeast(value, minimum = DOOR_MIN_AITERM) {
  const a = version(value), b = version(minimum)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return true
}

// Writes the door program to the host when it is missing or different, then runs its `register` mode (reads the hook env).
// The text is the hook's only argument after the code, so no package, no separate deploy. An old door process keeps its text until it exits.
const BOOTSTRAP = `import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync } from 'node:child_process'
const dir = path.join(os.homedir(), '.bellteam'), file = path.join(dir, 'approval-box-door.mjs'), source = process.argv[1]
try { if (fs.readFileSync(file, 'utf8') !== source) throw 0 } catch {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temporary = file + '.' + process.pid
  fs.writeFileSync(temporary, source, { mode: 0o600 })
  try { fs.renameSync(temporary, file) } catch { fs.writeFileSync(file, source, { mode: 0o600 }); fs.rmSync(temporary, { force: true }) }
}
spawnSync(process.execPath, [file, 'register'], { stdio: 'inherit', env: process.env, timeout: 8000 })`

const SOURCE = readFileSync(new URL('./approval-door-host.mjs', import.meta.url), 'utf8')
const COMMAND = Object.freeze(['node', '--input-type=module', '-e', BOOTSTRAP, SOURCE])

/** The agent_launch field to add for a terminal-bound seat (never a fork), or {} when the terminal's Aiterm cannot run it. */
export const doorHook = (remoteVersion, localVersion) =>
  atLeast(remoteVersion) && atLeast(localVersion) ? { post_launch: { command: [...COMMAND] } } : {}
