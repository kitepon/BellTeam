// Bundled body swap: which Aiterm stores the target cannot read (Elegg's aiterm.state-compat.v1), and moving only those aside.
import { mkdirSync, readFileSync, renameSync, appendFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const id = /^[a-z0-9][a-z0-9._-]{0,63}$/, version = /^(\d+)\.(\d+)\.(\d+)$/
const compare = (a, b) => {
  const x = a.match(version).slice(1).map(Number), y = b.match(version).slice(1).map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const ids = value => value === undefined ? [] : Array.isArray(value) && value.every(v => id.test(v)) ? value : invalid()
function invalid() { throw new Error('AITERM_STATE_COMPAT_INVALID') }

export function parseDeclaration(text) {
  if (text === null || text === undefined) return null
  const d = JSON.parse(text)
  if (d?.schema !== 'aiterm.state-compat.v1' || !d.stores || typeof d.stores !== 'object' || Array.isArray(d.stores)) invalid()
  const paths = []
  for (const [store, s] of Object.entries(d.stores)) {
    const segments = typeof s?.path === 'string' ? s.path.split('/') : []
    if (!id.test(store) || !segments.length || segments.some(x => !x || x === '.' || x === '..') || segments[0].startsWith('.bellteam-')
      || (s.writes !== undefined && !id.test(s.writes))) invalid()
    ids(s.reads); ids(s.resets)
    if (s.legacy !== undefined && !(Array.isArray(s.legacy) && s.legacy.every(l => version.test(l?.from) && version.test(l?.through) && id.test(l?.format)))) invalid()
    paths.push(s.path)
  }
  if (paths.some(a => paths.some(b => a !== b && b.startsWith(a + '/')))) invalid()
  return d
}

// source/target: {version, declaration} as read from each image's aiterm-mcp package root. Never throws: unknown keeps state.
export function selectResets(source, target) {
  let wanted, previous = null
  try { wanted = parseDeclaration(target?.declaration) } catch { return { resets: [], note: 'TARGET_DECLARATION_INVALID' } }
  if (!wanted) return { resets: [], note: 'TARGET_UNDECLARED' }
  try { previous = parseDeclaration(source?.declaration) } catch {}
  const old = typeof source?.version === 'string' && version.test(source.version) ? source.version : null
  const resets = []
  for (const [store, s] of Object.entries(wanted.stores)) {
    const format = previous?.stores?.[store]?.writes
      ?? (old && (s.legacy ?? []).find(l => compare(l.from, old) <= 0 && compare(old, l.through) <= 0)?.format)
    if (format && (s.resets ?? []).includes(format)) resets.push({ store, path: s.path, format })
  }
  return { resets, note: null }
}

// After the old body stopped: rename reset stores into .bellteam-reset/<stamp>/ and log the line. Nothing is deleted.
export function applyResets(root, selection, line, now = new Date()) {
  const base = join(root, '.bellteam-reset'), stamp = now.toISOString().replace(/[-:.]/g, '')
  for (const { path } of selection?.resets ?? []) {
    // Elegg: {uid} is the Aiterm process UID; apply runs as that UID (1000:1000).
    const own = path.replaceAll('{uid}', String(process.getuid())), from = join(root, own), to = join(base, stamp, own)
    if (!existsSync(from)) continue
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
    renameSync(from, to)
  }
  mkdirSync(base, { recursive: true, mode: 0o700 })
  appendFileSync(join(base, 'aiterm-state.log'), `${now.toISOString()} ${line}\n`, { mode: 0o600 })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [mode, ...args] = process.argv.slice(2)
  if (mode === 'select') {
    let input = []
    try { input = JSON.parse(readFileSync(0, 'utf8')) } catch {}
    const selection = selectResets(input[0], input[1])
    // Line 2 is the suffix of the installer's aiterm=preserved line.
    console.log(JSON.stringify(selection) + '\n' + (selection.note ? ` note=${selection.note}` : selection.resets.length ? ` reset=${selection.resets.map(r => r.store).join(',')}` : ''))
  } else if (mode === 'apply') {
    // Selection on stdin; empty = none (reset path). A malformed selection throws: the installer reports the failed step.
    const [root, line] = args, text = readFileSync(0, 'utf8').trim()
    applyResets(root, text ? JSON.parse(text) : null, line)
  } else process.exit(2)
}
