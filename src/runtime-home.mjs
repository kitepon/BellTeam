import { cp, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const localHome = fileURLToPath(new URL('../runtime/home', import.meta.url))

// 実行ユーザーのHOMEは製品の所有物ではない。コンテナはBELLTEAM_HOMEで既存volumeを指定する。
export function runtimeHome(environment = process.env) {
  const home = environment.BELLTEAM_HOME ?? localHome
  if (!isAbsolute(home)) throw new Error('BELLTEAM_HOME_ABSOLUTE_REQUIRED')
  return home
}

// 本体だけが使う合鍵。本体が起こす道具と席へは渡さない（診断の管理口の鍵。読むのは feature-settings.mjs）。
const SERVER_ONLY_KEYS = ['BELLTEAM_BUGHUB_KEY']

export function runtimeEnvironment(inherited = process.env, home = runtimeHome(inherited)) {
  const environment = {
    ...inherited,
    BELLTEAM_HOME: home,
    HOME: home,
    CODEX_HOME: join(home, '.codex'),
    GROK_HOME: join(home, '.grok'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local/state'),
  }
  // 明示するとClaudeのuser MCP正本まで .claude/.claude.json へ移る。HOME既定に揃える。
  delete environment.CLAUDE_CONFIG_DIR
  for (const name of SERVER_ONLY_KEYS) delete environment[name]
  return environment
}

export const runtimeEnvironmentKeys = Object.keys(runtimeEnvironment({}, localHome))

const missing = error => { if (error.code !== 'ENOENT') throw error; return null }
const sizes = async root => Promise.all((await readdir(root, { recursive: true })).sort()
  .map(async name => { const entry = await lstat(join(root, name)); return [name, entry.isDirectory() ? -1 : entry.size] }))

// Moves one directory to a destination that does not exist yet. Never overwrites; on failure the source stays.
async function moveOnce(source, destination, move) {
  if (!(await readdir(source).catch(missing))?.length) return 'nothing'
  if (await lstat(destination).catch(missing)) return 'kept'
  await mkdir(dirname(destination), { recursive: true })
  try { await move(source, destination); return 'moved' } catch (error) { if (error.code !== 'EXDEV') throw error }
  const staging = `${destination}.migrating-${process.pid}`
  try {
    await cp(source, staging, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true })
    if (JSON.stringify(await sizes(source)) !== JSON.stringify(await sizes(staging)))
      throw Object.assign(new Error('THROUGHLINE_MIGRATION_SIZE_MISMATCH'), { code: 'THROUGHLINE_MIGRATION_SIZE_MISMATCH' })
    await move(staging, destination)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
  await rm(source, { recursive: true, force: true })
  return 'copied'
}

// Throughline ADR 0073: THROUGHLINE_HOME is the one root. Move the pre-contract default roots
// (documented defaults: ~/.throughline, $XDG_STATE_HOME/throughline, $XDG_CONFIG_HOME/throughline) into it once.
// Run as the seat UID that owns the files, before anything runs Throughline. Each move is reported alone.
export async function migrateThroughlineStorage(environment = process.env, { move = rename } = {}) {
  const home = environment.THROUGHLINE_HOME
  if (!home || !isAbsolute(home)) return []
  const pairs = [[environment.HOME, '.throughline', home], [environment.XDG_STATE_HOME, 'throughline', join(home, 'app-state')],
    [environment.XDG_CONFIG_HOME, 'throughline', join(home, 'app-config')]].filter(([base]) => base && isAbsolute(base))
  const results = []
  for (const [base, name, destination] of pairs) {
    const source = join(base, name)
    try { results.push({ source, destination, status: await moveOnce(source, destination, move) }) }
    catch (error) { results.push({ source, destination, status: 'failed', code: error.code ?? error.message }) }
  }
  return results
}
