// Bot MCP tool for the hosted Approval Box connector the body hosts (docs/architecture/modules/runtime/approval-box-daemon.md).
// Read-only diagnostic for the body's own Bot. The pairing is the 決裁箱拡張 module's P3 (the Owner's own view); no tool carries its secrets any more.
import { objectSchema, assertKeys } from './mcp-schema.mjs'

export const APPROVAL_BOX_PAIRING_BOT = 'bot-39be7047'
export const approvalBoxDaemonTools = Object.freeze([
  { name: 'approval_box_daemon_status',
    description: '本体が常駐させている決裁箱のコネクタ（approval-box daemon）の状態を返す。mode（not_paired / starting / pc）、paired、reason、版。egress=trueなら、この箱から中継への通信（STUN/TURNのUDPとTCP443）が出られるかを各宛先ごとに確かめて返す。本体の担当Botだけが使う。',
    inputSchema: objectSchema({ egress: { type: 'boolean', description: 'trueで外向きの通信を確かめる（各3秒まで）。' } }),
    annotations: { readOnlyHint: true } },
])

const refuse = code => Object.assign(new Error(code), { code, status: code === 'APPROVAL_BOX_DAEMON_UNAVAILABLE' ? 503 : 403 })

export async function callApprovalBoxDaemonTool({ name, args = {}, from, fork = false, approvalBoxDaemon }) {
  if (from !== APPROVAL_BOX_PAIRING_BOT || fork) throw refuse('APPROVAL_BOX_DAEMON_NOT_ALLOWED')
  if (!approvalBoxDaemon?.available?.()) throw refuse('APPROVAL_BOX_DAEMON_UNAVAILABLE')
  if (name === 'approval_box_daemon_status') { assertKeys(args, ['egress']); return approvalBoxDaemon.status({ withEgress: args.egress === true }) }
  throw new Error(`TOOL_NOT_FOUND: ${name}`)
}
