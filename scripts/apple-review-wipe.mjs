#!/usr/bin/env node
// Apple review server: remove what reviewers leave behind, keep the demo setup.
// usage: node apple-review-wipe.mjs check|wipe <review server runtime dir>   (the dir holding data/ and home/)
// check is read-only and prints counts per category, never values.
import {lstat, readdir, readFile, rename, rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

const except = (...names) => names // every entry of the directory except these is removed

// [category, path (a * segment matches any one name), keep: names that stay inside a directory | 'keys:...' for JSON]
export const WIPE = [
  ['push-devices', 'data/state/push-devices.json'],
  ['push-devices', 'data/state/fcm-devices.json'],
  ['purchase-records', 'data/shared/subscription.json', {reset: ['signedTransaction', 'verification', 'error']}],
  ['typed-content', 'data/logs'],
  ['typed-content', 'data/rooms'],
  ['typed-content', 'data/state/owner-questions'],
  ['typed-content', 'data/state/secret-requests'],
  ['typed-content', 'data/bots/*/memory'],
  ['typed-content', 'data/bots/*/play'],
  ['typed-content', 'data/bots/*/docs'],
  ['typed-content', 'data/bots/*/rag/notes'],
  ['typed-content', 'data/bots/*/rag/raw'],
  ['typed-content', 'data/bots/*/rag/index.db'],
  ['typed-content', 'data/shared/memory'],
  ['typed-content', 'data/shared/play'],
  ['typed-content', 'data/shared/rag/notes'],
  ['typed-content', 'data/shared/rag/raw'],
  ['typed-content', 'data/shared/rag/index.db'],
  ['cli-transcripts', 'home/.bash_history'],
  ['cli-transcripts', 'home/.throughline'],
  ['cli-transcripts', 'home/.codex', {keep: except('auth.json', 'auth.lock', 'config.toml', 'hooks.json', 'hooks.json.aiterm-backup',
    'AGENTS.md', 'installation_id', 'models_cache.json', '.sandbox_migration', 'skills', 'plugins', 'cache', 'mcp-oauth-locks')}],
  ['cli-transcripts', 'home/.claude', {keep: except('AGENTS.md', 'CLAUDE.md', 'settings.json', 'settings.json.aiterm-backup',
    'settings.json.bak', 'commands', 'plugins', 'backups')}],
  ['cli-transcripts', 'home/.cursor', {keep: except('AGENTS.md', 'cli-config.json', 'hooks.json', 'hooks.json.aiterm-backup',
    'mcp.json', 'statsig-cache.json', 'agent-cli-state.json')}],
  ['cli-transcripts', 'home/.gemini', {keep: except('AGENTS.md', 'config', 'antigravity-cli')}],
  ['cli-transcripts', 'home/.gemini/antigravity-cli', {keep: except('installation_id', 'builtin', 'mcp', 'cache')}],
  ['cli-transcripts', 'home/.grok', {keep: except('agent_id', 'AGENTS.md', 'config.toml', 'hooks', 'installed-plugins', 'docs',
    'README.md', '.metadata_version', '.config-init.lock', 'managed_config.lock')}],
]

// Everything else stays. check lists names under these roots that no rule covers, so a new store is seen, not silently kept or deleted.
const KEEP = ['data/bots/*/bot.json', 'data/bots/*/AGENTS.md', 'data/bots/*/CLAUDE.md', 'data/bots/*/schedule.json',
  'data/bots/*/assets', 'data/bots/*/environment', 'data/bots/*/.git', 'data/bots/.initialized', 'data/owner',
  'data/shared/onboarding.json', 'data/shared/tools', 'data/shared/rag/INDEX.md', 'data/bots/*/rag/INDEX.md',
  'home/.cache', 'home/.npm', 'home/.local', 'home/.config', 'home/Library', 'home/.claude.json', 'home/.claude.json.lock']

const segs = p => p.split('/')
const covers = (rule, path) => { // rule is path or an ancestor of it
  const r = segs(rule), p = segs(path)
  return r.length <= p.length && r.every((s, i) => s === '*' || s === p[i])
}
const ancestorOf = (path, rule) => segs(path).length < segs(rule).length && covers(segs(rule).slice(0, segs(path).length).join('/'), path)

const kind = async p => (await lstat(p).catch(() => null)) // null when absent
async function countFiles(p) {
  const st = await kind(p)
  if (!st) return {files: 0, bytes: 0, oldest: null}
  if (!st.isDirectory()) return {files: 1, bytes: st.size, oldest: st.mtimeMs}
  let files = 0, bytes = 0, oldest = null
  for (const name of await readdir(p)) {
    const c = await countFiles(join(p, name))
    files += c.files; bytes += c.bytes
    if (c.oldest !== null) oldest = oldest === null ? c.oldest : Math.min(oldest, c.oldest)
  }
  return {files, bytes, oldest}
}

// Expand a rule's * segments into real paths under root.
async function expand(root, rule) {
  let paths = ['']
  for (const s of segs(rule)) {
    const next = []
    for (const base of paths) {
      if (s !== '*') { next.push(base ? base + '/' + s : s); continue }
      const st = await kind(join(root, base))
      if (st?.isDirectory()) for (const n of await readdir(join(root, base))) next.push(base + '/' + n)
    }
    paths = next
  }
  return paths
}

// Each target is what a rule removes: [category, path, rule options]. A directory with keep removes its other entries only.
async function targets(root) {
  const out = []
  for (const [category, rule, opt = {}] of WIPE)
    for (const path of await expand(root, rule)) {
      const st = await kind(join(root, path))
      if (!st) continue
      if (opt.reset) { // JSON file: the listed keys go back to null, which is the server's own empty state
        const doc = JSON.parse(await readFile(join(root, path), 'utf8'))
        const filled = opt.reset.filter(k => doc[k] != null)
        if (filled.length) out.push({category, path, reset: opt.reset, files: filled.length, bytes: 0, oldest: st.mtimeMs})
      } else if (opt.keep) {
        for (const name of await readdir(join(root, path)))
          if (!opt.keep.includes(name))
            out.push({category, path: path + '/' + name, ...(await countFiles(join(root, path, name)))})
      } else out.push({category, path, ...(await countFiles(join(root, path)))})
    }
  return out
}

async function unclassified(root) {
  const rules = [...WIPE.map(r => r[1]), ...KEEP], found = []
  async function walk(path) {
    for (const name of (await readdir(join(root, path)).catch(() => [])).sort()) {
      const p = path ? path + '/' + name : name
      if (rules.some(r => covers(r, p))) continue
      if (rules.some(r => ancestorOf(p, r)) && (await kind(join(root, p)))?.isDirectory()) await walk(p)
      else found.push(p)
    }
  }
  await walk('data'); await walk('home')
  return found
}

export async function check(root) {
  const t = await targets(root), categories = {}
  for (const x of t) {
    const c = categories[x.category] ??= {entries: 0, files: 0, bytes: 0, oldest: null} // oldest: oldest file mtime, to show nothing predates a wipe
    c.entries++; c.files += x.files; c.bytes += x.bytes
    if (x.oldest !== null) c.oldest = c.oldest === null ? x.oldest : Math.min(c.oldest, x.oldest)
  }
  for (const c of Object.values(categories)) if (c.oldest !== null) c.oldest = new Date(c.oldest).toISOString()
  return {categories, unclassified: await unclassified(root)}
}

export async function wipe(root) {
  const before = await check(root)
  for (const x of await targets(root)) {
    if (x.reset) {
      const file = join(root, x.path), doc = JSON.parse(await readFile(file, 'utf8'))
      for (const k of x.reset) doc[k] = null
      await writeFile(file + '.tmp', JSON.stringify(doc, null, 2) + '\n', {mode: (await lstat(file)).mode & 0o777})
      await rename(file + '.tmp', file)
    } else await rm(join(root, x.path), {recursive: true, force: true})
  }
  return {before, after: await check(root)}
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [mode, root] = process.argv.slice(2)
  if (!['check', 'wipe'].includes(mode) || !root) { console.error('usage: apple-review-wipe.mjs check|wipe <runtime dir>'); process.exit(2) }
  console.log(JSON.stringify(await (mode === 'check' ? check : wipe)(root), null, 1))
}
