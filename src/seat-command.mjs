// Planned Linux container boundary. Installation and production wiring are
// separate; never substitute the developer checkout for the root-owned entry.
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixedResumeBase } from './resume-policy.mjs'

const invalid = code => Object.assign(new Error(code), { code })
export function requireSeatProject(project) {
  if (typeof project !== 'string' || !isAbsolute(project) || project.includes('\0'))
    throw invalid('SEAT_PROJECT_INVALID')
  return project
}

// O2 (runtime/auth-mediation-child.md): a secret environment reaches the seat command only as one JSON line first on stdin (flag --env-stdin in argv, never a value),
// so it is in no argv and no file. The same rules run in the parent and again in run-seat-command (the privileged side does not trust the parent).
export const SECRET_ENV_MAX_NAMES = 32, SECRET_ENV_MAX_BYTES = 64 * 1024
const SECRET_ENV_REFUSED = name => name === 'PATH' || name === 'HOME' || name === 'NODE_OPTIONS' || name.startsWith('LD_') || name.startsWith('BELLTEAM_')
export function validateSecretEnv(value, existing = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid('SEAT_SECRET_ENV_INVALID')
  const names = Object.keys(value)
  let bytes = 0
  if (names.length > SECRET_ENV_MAX_NAMES) throw invalid('SEAT_SECRET_ENV_INVALID')
  for (const name of names) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(name) || SECRET_ENV_REFUSED(name) || Object.hasOwn(existing, name)) throw invalid('SEAT_SECRET_ENV_INVALID')
    if (typeof value[name] !== 'string' || value[name].includes('\0')) throw invalid('SEAT_SECRET_ENV_INVALID')
    bytes += Buffer.byteLength(value[name])
  }
  if (bytes > SECRET_ENV_MAX_BYTES) throw invalid('SEAT_SECRET_ENV_INVALID')
  return value
}

export function seatCommandSpec(command, args = [], { project, environment = 'configured', secretEnv = false } = {}) {
  requireSeatProject(project)
  if (!['configured', 'base'].includes(environment)) throw invalid('SEAT_ENVIRONMENT_MODE_INVALID')
  if (typeof command !== 'string' || !command
    || !Array.isArray(args) || !args.every(value => typeof value === 'string'))
    throw invalid('SEAT_COMMAND_ARGUMENTS')
  return {
    command: 'sudo',
    args: ['-n', '--', '/usr/local/libexec/bellteam-seat-exec', '--', process.execPath,
      fileURLToPath(new URL('./run-seat-command.mjs', import.meta.url)), project,
      ...(environment === 'base' ? ['--base-environment'] : []),
      ...(fixedResumeBase() ? ['--resume-state-base'] : []), ...(secretEnv ? ['--env-stdin'] : []), '--', command, ...args],
    // No inherited server environment; the privileged entry clears even this.
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
  }
}
