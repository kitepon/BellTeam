// One path rule per terminal OS (terminals README "Windows and Linux terminals"); members uses the same rule.
// macos/linux: POSIX absolute. windows: drive-absolute native form `X:\...` with backslashes only, `X:\` is the root.
export const TERMINAL_OS = ['macos', 'linux', 'windows']
export const OS_LABEL = { macos: 'Mac', linux: 'Linux', windows: 'Windows' }

const DRIVE_ROOT = /^[A-Za-z]:\\$/
const windows = os => os === 'windows'
export const separator = os => windows(os) ? '\\' : '/'
export const isRoot = (os, path) => windows(os) ? DRIVE_ROOT.test(path) : path === '/'

export function isTerminalPath(os, path) {
  if (!TERMINAL_OS.includes(os) || typeof path !== 'string' || path.length > 1024 || path.includes('\0')) return false
  if (isRoot(os, path)) return true
  if (windows(os) ? !/^[A-Za-z]:\\/.test(path) || path.includes('/') : !path.startsWith('/')) return false
  return path.slice(windows(os) ? 3 : 1).split(separator(os)).every(part => part && part !== '.' && part !== '..' && !(windows(os) && part.includes(':')))
}

// A child name from a listing: no separator of either kind, no NUL, no drive colon on Windows.
export const isEntryName = (os, name) => typeof name === 'string' && !!name && !name.includes('/') && !name.includes('\\') && !name.includes('\0')
  && !(windows(os) && name.includes(':')) && name !== '.' && name !== '..'

export const childPath = (os, at, name) => isRoot(os, at) ? `${at}${name}` : `${at}${separator(os)}${name}`
export function parentPath(os, at) {
  if (isRoot(os, at)) return null
  const cut = at.lastIndexOf(separator(os))
  return windows(os) ? (cut <= 2 ? at.slice(0, 3) : at.slice(0, cut)) : (at.slice(0, cut) || '/')
}

export function defaultProjectRoot(os, user, slug) {
  if (windows(os)) return `C:\\Users\\${user}\\BellTeam\\${slug}`
  return `${os === 'linux' ? '/home' : '/Users'}/${user}/BellTeam/${slug}`
}
