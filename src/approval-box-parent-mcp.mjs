// Bot tool of the 決裁箱拡張 module (P8, seats-on-hosted-daemon.md section 10): the module owner's seat asks for the Owner's QR. The answer holds no secret.
import { objectSchema, assertKeys } from './mcp-schema.mjs'
import { createSeatLinkQr } from './approval-box-parent-seat-link-qr.mjs'

export const APPROVAL_BOX_EXTENSION_BOT = 'bot-ae42e3e9'
export const seatLinkTools = Object.freeze([
  { name: 'approval_box_seat_link_show',
    description: '決裁箱拡張の担当（デルタ）だけが使う。本体の決裁箱の接続（席の接続）を始め、iPhone の決裁箱で読むQRコードを、指揮官の会話画面に画像で出す（8文字と16文字のコードも文字で添える）。コードは指揮官の会話にだけ出て、この道具の答えには入らない。答え: posted（expiresAt はJST表示用のISO時刻）/ linked（すでにつながっている）/ not_started（reason）/ post_failed。',
    inputSchema: objectSchema({}),
    annotations: { readOnlyHint: false } },
])

const refuse = code => Object.assign(new Error(code), { code, status: code === 'APPROVAL_BOX_DAEMON_UNAVAILABLE' ? 503 : 403 })

export async function callSeatLinkTool({ name, args = {}, from, fork = false, approvalBoxDaemon, messenger }) {
  if (from !== APPROVAL_BOX_EXTENSION_BOT || fork) throw refuse('APPROVAL_BOX_SEAT_LINK_NOT_ALLOWED')
  if (!approvalBoxDaemon?.pairing || !messenger) throw refuse('APPROVAL_BOX_DAEMON_UNAVAILABLE')
  if (name !== 'approval_box_seat_link_show') throw new Error(`TOOL_NOT_FOUND: ${name}`)
  assertKeys(args, [])
  const post = ({ message, image }) => messenger.sendmessage({ from, target: 'user', message, images: [image] })
  return createSeatLinkQr({ pairing: approvalBoxDaemon.pairing, post }).show()
}
