// Aiterm（担当エレグ）の親配送hookを、BellTeamコンテナの共有設定へ登録する。
// hookが無いと、Claude Code・Cursorの席からの agent_launch・pty_send が CLAUDE_PARENT_HOOK_UNAVAILABLE で拒まれる。
// 本家の `aiterm-setup` は起こさず、同梱のdistの関数を呼ぶ（`aiterm-setup --hooks-only` と同じ登録になる）。
// BellTeamが足すのはAitermのhookの項目だけで、登録済みなら何も書かない。
import { access, constants } from 'node:fs/promises'
import { join } from 'node:path'

export const AITERM_DIST = '/usr/local/lib/node_modules/aiterm-mcp/dist'
// MCPを使う時だけ本体を起こす中継（mcp-lazy。担当レオナ）。BellTeamコンテナに初期搭載している（Dockerfile）。
export const MCP_LAZY_RELAY = '/usr/local/bin/mcp-lazy'
// コンテナに初期搭載しているCodex（Dockerfile）。
export const CODEX_BINARY = '/usr/local/bin/codex'

// 中継の実体があればそのpathを返す。無い環境（コンテナの外での起動など）ではnullを返し、Aitermは直結で登録する。
export async function aitermRelay({ path = MCP_LAZY_RELAY } = {}) {
  try {
    await access(path, constants.X_OK)
    return path
  } catch {
    return null
  }
}

// `aiterm-setup` が書く登録と同じ形（nodeの絶対path＋index.js）。MCPの登録（harness-config.mjs）にも同じものを使う。
// 形が違うと、席が引数なしの `aiterm-setup` を流した時にCodex・Grokの登録が作り直され、BellTeamが書いたtimeoutが消える。
export async function aitermRegistration({ dist = AITERM_DIST, load = path => import(path) } = {}) {
  const { setupNodeExecutable } = await load(join(dist, 'setup-node.js'))
  return { command: setupNodeExecutable(), args: [join(dist, 'index.js')] }
}

// Codexの席が親の時の配送hookは、Aiterm 0.56.0 から登録する（`aiterm-setup --codex-steer enable` と同じ登録になる）。
// 無いと、Codexの席が起こした子の回答と、Aitermの配送に乗る製品（Approval Box）の回答が、番の終わりまで届かない。
// AitermはCodexを一時的に起こして登録の読み戻しと承認をする。登録済みなら何も書かない。古いAitermには入口が無いので登録しない。
// 返す `codex` はAitermの結果（status が ready 以外の時の記録は呼び出し元がする）。
export async function configureAitermHooks(home, { dist = AITERM_DIST, load = path => import(path), codex = CODEX_BINARY } = {}) {
  const { mergeClaudeParentHooks, mergeCursorParentHooks, ensureCodexParentSteer } = await load(join(dist, 'setup-integrations.js'))
  const registration = await aitermRegistration({ dist, load })
  mergeClaudeParentHooks(join(home, '.claude/settings.json'), registration)
  mergeCursorParentHooks(join(home, '.cursor/hooks.json'), registration)
  if (!ensureCodexParentSteer) return { codex: null }
  return { codex: await ensureCodexParentSteer(home, { binary: codex }) }
}
