import { ownerInstructions } from '../owner-profile.mjs'
import { userRulesInstructions } from '../user-rules.mjs'

// shortcut: matches the 統括 substring of 役職 as the Owner defined it; upgrade if coordinators get a structured flag.
const COORDINATOR_NOTE = '# 統括の担当割り当て\n\n仕事や裁定の担当（誰の工程か）を割り当てる、または割り当て直す前に、必ず `/srv/bellteam/shared/tools/assign-owner/SKILL.md` に従う。\n\n'

export function renderBotInstructions(profile, shortTermMemory = '') {
  const coordinator = profile.position?.includes('統括') ? COORDINATOR_NOTE : ''
  return `# 自分のBot情報\n\nあなたのBellTeam Bot IDは \`${profile.id}\` である。\n\n## 名前\n\n「${profile.name}」\n\n## プロフィール\n\n「${profile.profileText || '指定なし'}」\n\n## 性格（考え方）\n\n「${profile.personality || '指定なし'}」\n\n## 口調\n\n「${profile.speechStyle || '指定なし'}」\n\n## 役職\n\n「${profile.position || '指定なし'}」\n\n## 役割\n\n「${profile.role || '指定なし'}」\n\n${coordinator}# 作業手順\n\n上の役割は、あなた自身が責任を持って進める担当の仕事である。役割欄は担当を短く記し、具体的な作業手順はここへ混ぜない。作業手順の詳細はこのプロジェクトの \`docs/\` に自分で置き、着手前に読む。\n\n# 前セッションの短期記憶\n\n${shortTermMemory || 'なし'}\n`
}

export function renderGlobalInstructions(owner, rules, commonRules) {
  return `${ownerInstructions(owner)}\n\n${userRulesInstructions(rules)}\n\n${commonRules}`
}

// Remote seat C6 (modules/members/remote-seat.md): where the canonical files live when cwd is the user's folder.
export function renderRemoteAccessNote(profile) {
  return `# Remote seat\n\nThis seat runs on a registered terminal with cwd = \`${profile.projectRoot}\`. That folder and the terminal's home belong to the user; never create BellTeam AGENTS/CLAUDE/memory files there. Your canonical \`docs/\` and \`AGENTS.local.md\` stay in BellTeam: use the BellTeam MCP tools \`list_member_docs\`, \`read_member_doc\` and \`write_member_doc\` (paths \`AGENTS.local.md\` or \`docs/<relative>\`). Memory and knowledge use the existing BellTeam memory tools. Wherever these instructions mention "this project's docs/", read it as those tools.\n`
}
