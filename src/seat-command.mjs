// Planned Linux container boundary. Installation and production wiring are
// separate; never substitute the developer checkout for the root-owned entry.
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

export function seatCommandSpec(command, args = [], { project } = {}) {
  if (!isAbsolute(project ?? '') || typeof command !== 'string' || !command
    || !Array.isArray(args) || !args.every(value => typeof value === 'string'))
    throw new Error('SEAT_COMMAND_ARGUMENTS')
  return {
    command: 'sudo',
    args: ['-n', '--', '/usr/local/libexec/bellteam-seat-exec', '--', process.execPath,
      fileURLToPath(new URL('./run-seat-command.mjs', import.meta.url)), project, '--', command, ...args],
    // No inherited server environment; the privileged entry clears even this.
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
  }
}
