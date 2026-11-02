import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { returnedMcpError } from './returned-mcp-error.mjs'
import { deliveryTracking } from './delivery-tracking.mjs'
import { launchFailureDetails } from './agent-launch-error.mjs'

// 直接会話と部屋で同じ返却を同じ保存fieldへ写す。配送の結論はtransportが持つ。
export function deliveryFailureFields(error) {
  const detail = returnedMcpError(error)
  const launch = launchFailureDetails(error)
  return {
    ...(detail ? { mcp_error: detail } : {}),
    ...(launch ? { native_launch: launch } : {}),
  }
}

export class ConversationWriter {
  constructor({ logPath, now, id, onMessage }) {
    this.logPath = logPath
    this.now = now
    this.deliveryId = id
    this.onMessage = onMessage
  }

  async append(record) {
    await mkdir(dirname(this.logPath), { recursive: true })
    await appendFile(this.logPath, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    this.onMessage(record)
  }

  // 合間の言葉は、そのBotと指揮官の会話画面に出すだけの記録。誰にも配送せず、返信の候補にも通知にもならない。
  // Bot同士の連絡や通話で始まったターンの最後の回答（kind: 'answer'）も、同じ記録として画面にだけ出す。
  async appendInterimWords(botId, groupId, words) {
    for (const word of words) {
      await this.append({
        schema: 'bellteam.interim-word.v1', id: this.deliveryId(), at: this.now(),
        bot: botId, group_id: groupId, text: word.text,
        ...(word.kind === 'error' || word.kind === 'answer' ? { kind: word.kind } : {}),
        ...(word.at ? { written_at: word.at } : {}),
      })
    }
  }

  appendDeliveryStatus(deliveryId, delivery, error = null, tracking = null) {
    const detail = deliveryTracking(delivery, tracking)
    return this.append({
      schema: 'bellteam.delivery-status.v1', delivery_id: deliveryId, at: this.now(), delivery,
      ...deliveryFailureFields(error),
      ...(detail ? { delivery_tracking: detail } : {}),
    })
  }
}
