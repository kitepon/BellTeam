// Planned Linux container boundary. Installation and production wiring are
// separate; never substitute the developer checkout for the root-owned entry.
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const invalid = code => Object.assign(new Error(code), { code })
export function requireSeatProject(project) {
  if (typeof project !== 'string' || !isAbsolute(project) || project.includes('\0'))
    throw invalid('SEAT_PROJECT_INVALID')
  return project
}

export function seatCommandSpec(command, args = [], { project } = {}) {
  requireSeatProject(project)
  if (typeof command !== 'string' || !command
    || !Array.isArray(args) || !args.every(value => typeof value === 'string'))
    throw invalid('SEAT_COMMAND_ARGUMENTS')
  return {
    command: 'sudo',
    args: ['-n', '--', '/usr/local/libexec/bellteam-seat-exec', '--', process.execPath,
      fileURLToPath(new URL('./run-seat-command.mjs', import.meta.url)), project, '--', command, ...args],
    // No inherited server environment; the privileged entry clears even this.
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
  }
}
