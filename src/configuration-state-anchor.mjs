import fs from 'node:fs'

const statePath = '/srv/bellteam/state'
const controlPath = '/run/bellteam-maintenance'
const invalid = () => { throw Object.assign(new Error('CONFIGURATION_STORAGE_INVALID'), { code: 'CONFIGURATION_STORAGE_INVALID', status: 503, effect: 'not_issued' }) }
const same = (a, b) => a.dev === b.dev && a.ino === b.ino

// Only the managed normal runtime may replace the consumer's full ancestor walk.
export function acquireConfigurationStateAnchor(root) {
  if (root !== '/srv/bellteam') return undefined
  try {
    if ([process.getuid(), process.geteuid(), process.getgid(), process.getegid()].some(id => id !== 1001)) invalid()
    const directory = (path, uid, gid, mode) => {
      const st = fs.lstatSync(path)
      if (!st.isDirectory() || st.uid !== uid || st.gid !== gid || st.mode & 0o022
        || mode !== undefined && (st.mode & 0o7777) !== mode || fs.realpathSync(path) !== path) invalid()
      return st
    }
    for (const path of ['/', '/srv', '/run']) directory(path, 0, 0)
    directory(root, 1000, 1000, 0o711)
    const control = directory(controlPath, 0, 1001, 0o750)
    const state = directory(statePath, 1001, 1001)
    if (!same(state, directory(`${controlPath}/state`, 1001, 1001))) invalid()
    const heldControl = fs.fstatSync(3), heldState = fs.fstatSync(4)
    if (!same(control, heldControl) || !same(state, heldState)) invalid()
    for (const [fd, lock] of [[3, 'READ'], [4, 'WRITE']]) {
      const info = fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8')
      if ((parseInt(info.match(/^flags:\s+([0-7]+)$/m)?.[1] ?? '3', 8) & 3) !== 0
        || !new RegExp(`^lock:\\s+\\d+:\\s+FLOCK\\s+ADVISORY\\s+${lock}\\s+${process.pid}\\s`, 'm').test(info)) invalid()
    }
    // A mounted leaf cannot be renamed by the seat-owned parent directory.
    const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n').map(line => line.split(' '))
    for (const [path, access] of [[controlPath, 'ro'], [statePath, 'rw']]) {
      const matches = mounts.filter(fields => fields[4] === path)
      if (matches.length !== 1 || !matches[0][5]?.split(',').includes(access) || !matches[0].includes('-')) invalid()
    }
    if (!same(state, directory(statePath, 1001, 1001))) invalid()
    if (![state.dev, state.ino].every(value => Number.isSafeInteger(value) && value >= 0)) invalid()
    return Object.freeze({ path: statePath, uid: 1001, dev: state.dev, ino: state.ino })
  } catch { invalid() }
}
