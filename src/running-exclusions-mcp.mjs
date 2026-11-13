// Bot MCP tools for the Owner-approved running exclusion list (execution current-work.md "Own work", a41).
// A Bot only proposes; the list changes only when the Owner approves the Approval Box decision.
import { objectSchema, assertKeys } from './mcp-schema.mjs'

const HOW = 'カードの「稼働中」の理由に出る「<exe> <args>」をそのまま使う。同じ申請が出ていれば、新しく出さずにその申請を返す。'
const reason = { type: 'string', minLength: 1, maxLength: 1000, description: 'なぜ稼働中に数えないでよいか。指揮官が読む。日本語で、何の処理か・なぜ終わらないかを書く' }
export const runningExclusionTools = Object.freeze([
  { name: 'propose_running_exclusion',
    description: `終わらない処理（開発用サーバーなど）を「稼働中」に数えないよう、指揮官に承認を申請する。承認されるまで一覧は変わらない。${HOW}子の席はkind=childでharnessとsession（省略=そのCLIのどの子の席でも）。`,
    inputSchema: objectSchema({
      kind: { type: 'string', enum: ['process', 'child'] },
      exe: { type: 'string', description: 'kind=process: 実行ファイルの名前（例 node）' },
      args: { type: 'array', maxItems: 2, items: { type: 'string' }, description: 'kind=process: 先頭2つまでの引数（例 ["vite.js","dev"]）。空=その実行ファイルのすべての処理' },
      harness: { type: 'string', enum: ['claude-code', 'codex-cli', 'grok-cli', 'cursor-cli', 'antigravity-cli'], description: 'kind=child: 子の席のCLI' },
      session: { type: 'string', description: 'kind=child: 子の席のsession名' },
      botIds: { type: 'array', minItems: 1, items: { type: 'string' }, description: '対象のBot ID。省略=申請したBot自身' },
      allBots: { type: 'boolean', description: 'trueですべてのBotが対象（botIdsと一緒に使わない）' },
      reason,
    }, ['kind', 'reason']) },
  { name: 'propose_running_exclusion_removal',
    description: '一覧の1件を外すよう、指揮官に承認を申請する。承認されると、その処理をまた稼働中に数える。idはlist_running_exclusionsで確かめる。',
    inputSchema: objectSchema({ id: { type: 'string', minLength: 1 }, reason }, ['id', 'reason']) },
  { name: 'list_running_exclusions',
    description: '稼働中に数えない処理の一覧（指揮官が承認した物）と、承認待ちの申請を見る。',
    inputSchema: objectSchema({}) },
])

export async function callRunningExclusionTool({ name, args = {}, from, registry, runningExclusions }) {
  if (!runningExclusions) throw Object.assign(new Error('RUNNING_EXCLUSIONS_UNAVAILABLE'), { code: 'RUNNING_EXCLUSIONS_UNAVAILABLE', status: 503 })
  if (name === 'list_running_exclusions') { assertKeys(args, []); return runningExclusions.list() }
  const requester = registry.get(from)?.name ?? from
  if (name === 'propose_running_exclusion_removal') {
    assertKeys(args, ['id', 'reason'])
    const { entries } = await runningExclusions.list()
    const entry = entries.find(item => item.id === args.id)
    return runningExclusions.propose({ action: 'remove', id: args.id, reason: args.reason, from, requester, who: whoOf(entry?.scope, registry) })
  }
  assertKeys(args, ['kind', 'exe', 'args', 'harness', 'session', 'botIds', 'allBots', 'reason'])
  if (args.allBots && args.botIds) throw Object.assign(new Error('RUNNING_EXCLUSION_INVALID: botIds と allBots は一緒に使わない'), { code: 'RUNNING_EXCLUSION_INVALID', status: 400 })
  const scope = args.allBots ? 'all' : args.botIds ?? [from]
  if (scope !== 'all') for (const id of scope) if (!registry.get(id)) throw new Error(`BOT_NOT_FOUND: ${id}`)
  const entry = args.kind === 'process' ? { kind: 'process', exe: args.exe, args: args.args ?? [], scope }
    : { kind: 'child', harness: args.harness, session: args.session ?? null, scope }
  return runningExclusions.propose({ action: 'add', entry, reason: args.reason, from, requester, who: whoOf(scope, registry) })
}

const whoOf = (scope, registry) => scope === 'all' ? 'すべての Bot' : Array.isArray(scope) ? scope.map(id => registry.get(id)?.name ?? id).join('・') : '対象の Bot'
