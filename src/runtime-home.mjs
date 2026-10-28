import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const localHome = fileURLToPath(new URL('../runtime/home', import.meta.url))

// 実行ユーザーのHOMEは製品の所有物ではない。コンテナはBELLTEAM_HOMEで既存volumeを指定する。
export function runtimeHome(environment = process.env) {
  const home = environment.BELLTEAM_HOME ?? localHome
  if (!isAbsolute(home)) throw new Error('BELLTEAM_HOME_ABSOLUTE_REQUIRED')
  return home
}

// 本体だけが使う合鍵。本体が起こす道具と席へは渡さない（診断の管理口の鍵。読むのは feature-settings.mjs）。
const SERVER_ONLY_KEYS = ['BELLTEAM_BUGHUB_KEY', 'BELLTEAM_NORMAL_ADMISSION_TOKEN']

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
