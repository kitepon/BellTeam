// Bot MCP tools for the hosted Approval Box connector the body supervises (docs/architecture/modules/runtime/approval-box-daemon.md, a490h).
// Only the body's own Bot runs the pairing step (the waiting line carries secrets): a named protection, not a role check on every tool.
import { objectSchema, assertKeys } from './mcp-schema.mjs'

export const APPROVAL_BOX_PAIRING_BOT = 'bot-39be7047'
export const approvalBoxDaemonTools = Object.freeze([
  { name: 'approval_box_daemon_status',
    description: '本体が常駐させている決裁箱のコネクタ（approval-box daemon）の状態を返す。mode（not_paired / starting / pc）、paired、reason、版。egress=trueなら、この箱から中継への通信（STUN/TURNのUDPとTCP443）が出られるかを各宛先ごとに確かめて返す。本体の担当Botだけが使う。',
    inputSchema: objectSchema({ egress: { type: 'boolean', description: 'trueで外向きの通信を確かめる（各3秒まで）。' } }),
    annotations: { readOnlyHint: true } },
  { name: 'approval_box_pair',
    description: 'コネクタを決裁箱へつなぐ手順（approval-box pair --json）を始め、waitingの行（code、typed_secret、qr_text、expires_at）を返す。この値はオーナーが電話で承認する一度の作業に使い、ログや記録へ貼らない。すでに待機中なら同じ行を返す。rebind=trueは再接続。本体の担当Botだけが使う。',
    inputSchema: objectSchema({ rebind: { type: 'boolean' } }) },
  { name: 'approval_box_pair_status',
    description: 'approval_box_pairの実行の状態（waiting / claimed / bound / ended / failed）と、これまでの行（秘密の値は含めない）を返す。本体の担当Botだけが使う。',
    inputSchema: objectSchema({}), annotations: { readOnlyHint: true } },
])

const refuse = code => Object.assign(new Error(code), { code, status: code === 'APPROVAL_BOX_DAEMON_UNAVAILABLE' ? 503 : 403 })

export async function callApprovalBoxDaemonTool({ name, args = {}, from, fork = false, approvalBoxDaemon }) {
  if (from !== APPROVAL_BOX_PAIRING_BOT || fork) throw refuse('APPROVAL_BOX_DAEMON_NOT_ALLOWED')
  if (!approvalBoxDaemon?.available?.()) throw refuse('APPROVAL_BOX_DAEMON_UNAVAILABLE')
  if (name === 'approval_box_daemon_status') { assertKeys(args, ['egress']); return approvalBoxDaemon.status({ withEgress: args.egress === true }) }
  if (name === 'approval_box_pair') { assertKeys(args, ['rebind']); return { waiting: await approvalBoxDaemon.pair({ rebind: args.rebind === true }) } }
  if (name === 'approval_box_pair_status') { assertKeys(args, []); return approvalBoxDaemon.pairStatus() }
  throw new Error(`TOOL_NOT_FOUND: ${name}`)
}
