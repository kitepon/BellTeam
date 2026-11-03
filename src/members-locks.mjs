import { fstatSync, lstatSync, readFileSync } from 'node:fs'

// These are newly opened by the fixed child entry, never inherited server locks.
export function verifyMembersLocks() {
  const fail = () => { throw new Error('MEMBERS_LOCK_INVALID') }
  if (process.getuid() !== 1001 || process.getgid() !== 1001) fail()
  const shared = fstatSync(4), writer = fstatSync(5)
  const root = lstatSync('/run/bellteam-maintenance'), lock = lstatSync('/srv/bellteam/state/members.lock')
  if (!shared.isDirectory() || shared.uid !== 0 || shared.gid !== 1001 || (shared.mode & 0o7777) !== 0o750
    || !writer.isFile() || writer.uid !== 1001 || writer.gid !== 1001 || writer.nlink !== 1 || (writer.mode & 0o7777) !== 0o600
    || shared.dev !== root.dev || shared.ino !== root.ino || writer.dev !== lock.dev || writer.ino !== lock.ino) fail()
  for (const [fd, kind] of [[4, 'READ'], [5, 'WRITE']]) {
    if (!new RegExp(`^lock:\\s+\\d+: FLOCK\\s+ADVISORY\\s+${kind}\\s+`, 'm')
      .test(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))) fail()
  }
}
