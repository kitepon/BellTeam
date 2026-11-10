import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { returnedMcpError } from './returned-mcp-error.mjs'
import { deliveryTracking } from './delivery-tracking.mjs'
import { launchFailureDetails } from './agent-launch-error.mjs'

export const DELIVERY_ERROR_CODES = Object.freeze(['BOT_OBSERVATION_FAILED', 'BOT_CONFIGURATION_FAILED',
  'BOT_LAUNCH_FAILED', 'BOT_SEND_FAILED', 'BOT_DELIVERY_FAILED', 'BOT_SESSION_UNCONFIRMED'])

export function deliveryError(delivery, value) {
  return delivery === 'failed' && DELIVERY_ERROR_CODES.includes(value?.code) ? { code: value.code } : null
}

// 直接会話と部屋で同じ返却を同じ保存fieldへ写す。配送の結論はtransportが持つ。
export function deliveryFailureFields(error) {
  const detail = returnedMcpError(error)
  const launch = launchFailureDetails(error)
  return {
    ...(error == null ? {} : { delivery_error: deliveryError('failed', error.delivery_error ?? error) ?? { code: 'BOT_DELIVERY_FAILED' } }),
    ...(detail ? { mcp_error: detail } : {}),
    ...(launch ? { native_launch: launch } : {}),
  }
}

export function forwardConversationWriter(writer, forward) {
  if (!(writer?.appendQueue instanceof Promise) || typeof writer.append !== 'function'
    || typeof writer.onMessage !== 'function' || typeof forward !== 'function')
    throw Object.assign(new Error('DIRECT_WRITER_HANDOFF_INVALID'), { code: 'DIRECT_WRITER_HANDOFF_INVALID' })
  const ready = writer.appendQueue
  writer.append = record => {
    const saved = writer.appendQueue.then(() => forward(record))
    writer.appendQueue = saved.catch(() => {})
    return saved.then(() => writer.onMessage(record))
  }
  return { ready }
}

export class ConversationWriter {
  constructor({ logPath, now, id, onMessage, failureFields = deliveryFailureFields }) {
    this.logPath = logPath
    this.now = now
    this.deliveryId = id
    this.onMessage = onMessage
    this.failureFields = failureFields
    this.appendQueue = Promise.resolve()
  }

  async append(record) {
    const line = `${JSON.stringify(record)}\n`
    const saved = this.appendQueue.then(async () => {
      await mkdir(dirname(this.logPath), { recursive: true })
      const file = await open(this.logPath, 'a+', 0o600)
      try {
        const { size } = await file.stat()
        let separator = ''
        if (size) {
          const tail = Buffer.alloc(1)
          const { bytesRead } = await file.read(tail, 0, 1, size - 1)
          if (bytesRead !== 1) throw new Error('MESSAGE_LOG_TAIL_CHANGED')
          // Preserve a crash fragment verbatim, but never join the next record to it.
          if (tail[0] !== 0x0a) separator = '\n'
        }
        await file.writeFile(separator + line)
        await file.sync()
      } finally { await file.close() }
    })
    this.appendQueue = saved.catch(() => {})
    await saved
    await this.onMessage(record)
  }

  // 合間の言葉は、そのBotと指揮官の会話画面に出すだけの記録。誰にも配送せず、返信の候補にも通知にもならない。
  // Bot同士の連絡や通話で始まったターンの最後の回答（kind: 'answer'）も、同じ記録として画面にだけ出す。
  async appendInterimWords(botId, groupId, words, label = null) {
    for (const word of words) {
      await this.append({
        schema: 'bellteam.interim-word.v1', id: this.deliveryId(), at: this.now(),
        bot: botId, group_id: groupId, text: word.text,
        ...(word.kind === 'error' || word.kind === 'answer' ? { kind: word.kind } : {}),
        ...(word.at ? { written_at: word.at } : {}),
        ...(label ?? {}),
      })
    }
  }

  appendDeliveryStatus(deliveryId, delivery, error = null, tracking = null) {
    const detail = deliveryTracking(delivery, tracking)
    return this.append({
      schema: 'bellteam.delivery-status.v1', delivery_id: deliveryId, at: this.now(), delivery,
      ...this.failureFields(error),
      ...(detail ? { delivery_tracking: detail } : {}),
    })
  }
}
