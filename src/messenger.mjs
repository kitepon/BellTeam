import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

import { memberIdentity } from './member-identity.mjs'
import { ConversationStore } from './conversation-store.mjs'

export function directEnvelope(from, message) {
  const identity = typeof from === 'string' ? { id: from, name: from, position: '', role: '' } : from
  const name = identity.id === 'user' ? 'オーナー' : identity.name
  return `「${name}」からあなたへ次のメッセージが届いています。\n\n${message}`
}

export function userEnvelope(from, message) {
  return directEnvelope(from, message)
}

export class BellTeamMessenger {
  // onTurnEndは、Botのターンが終わった時にオーナーへの報告漏れを確かめる処理（turn-reports.mjs）を呼ぶ。
  constructor({ bots, transport, logPath, assets = null, onMessage = () => {}, onTurnEnd = () => {}, requireAccess = async () => {}, now = () => new Date().toISOString(), deliveryId = randomUUID }) {
    this.bots = bots
    this.transport = transport
    this.logPath = logPath
    this.assets = assets
    this.onMessage = onMessage
    this.onTurnEnd = onTurnEnd
    this.requireAccess = requireAccess
    this.now = now
    this.deliveryId = deliveryId
    this.store = new ConversationStore({ logPath })
    this.claimedReplyIds = new Set()
  }

  // Botの送信（MCP）は画像1枚の `image`、ユーザーの送信は複数枚の `images` で渡す。
  async sendmessage({ from, target, message, image = null, images = image ? [image] : [] }) {
    await this.bots.refresh?.()
    if (!['user', 'scheduler'].includes(from) && !this.bots.has(from)) throw new Error(`SENDER_NOT_FOUND: ${from}`)
    if (target === 'user' && from === 'user') throw new Error('USER_TO_USER_NOT_ALLOWED')
    const bot = target === 'user' ? null : this.bots.get(target)
    if (target !== 'user' && !bot) throw new Error(`BOT_NOT_FOUND: ${target}`)
    if (typeof message !== 'string' || (message.length === 0 && !images.length)) throw new Error('MESSAGE_REQUIRED')
    images.forEach(validateImage)

    if (from === 'user') return this.enqueueUserTurn({ target, message, images })
    if (bot) await this.requireAccess({ from, target })

    const deliveryId = this.deliveryId()
    const imageAsset = images.length && target === 'user' && this.assets
      ? await this.assets.save({ owner: from, id: deliveryId, image: images[0] })
      : null
    const record = this.record({
      deliveryId, from, target, message, images, imageAsset,
      delivery: bot ? 'running' : 'delivered',
    })
    await this.append(record)
    let delivery = null
    if (bot) {
      delivery = await this.transport.notify(bot, directEnvelope(memberIdentity(this.bots, from), message), {
        images,
        queue: {
          context: 'direct', contextId: bot.id, groupId: deliveryId,
          from, fromName: memberIdentity(this.bots, from).name, target: bot.id, message,
        },
        onStatus: status => this.appendDeliveryStatus(deliveryId, status),
        onInterim: words => this.appendInterimWords(bot.id, deliveryId, words),
        onAnswer: text => this.appendInterimWords(bot.id, deliveryId, [{ text, kind: 'answer' }]),
        onTurnEnd: window => this.onTurnEnd({ botId: bot.id, context: 'direct', ...window }),
      })
    }
    return { delivery: delivery?.delivery ?? 'delivered', delivery_id: deliveryId, from, target }
  }

  async receiveCallBridge({ event, session_id: sessionId, target_id: target, source_system: sourceSystem, source_id: sourceId, source_label: sourceLabel, message, reply_required: replyRequired = true, seq = null }) {
    await this.bots.refresh?.()
    const bot = this.bots.get(target)
    if (!bot) throw new Error(`BOT_NOT_FOUND: ${target}`)
    const from = `call-bridge:${sourceSystem}:${sourceId}`
    await this.requireAccess({ from, target })
    const deliveryId = this.deliveryId()
    const identity = { id: from, name: sourceLabel, position: sourceSystem, role: '通話相手' }
    await this.append({
      schema: 'bellteam.direct-message.v1', delivery_id: deliveryId, at: this.now(),
      from, target, from_identity: identity, target_identity: memberIdentity(this.bots, target),
      message, image: false, delivery: 'running', session_id: sessionId,
    })
    const party = event === 'session.reply' ? 'local' : 'member'
    const replyHint = replyRequired === false ? ''
      : `\n\n返信する時は call-bridge MCP の call_send に session_id=${sessionId}、from_party=${party} を指定して。`
    const envelope = `「${sourceLabel}」（${sourceSystem}:${sourceId}）から通話が届いています。session_id=${sessionId}${seq == null ? '' : ` seq=${seq}`}\n\n${message}${replyHint}`
    try {
      const result = await this.transport.notify(bot, envelope, {
        queue: { context: 'direct', contextId: bot.id, groupId: deliveryId, from, fromName: sourceLabel, target: bot.id, message },
        onStatus: status => this.appendDeliveryStatus(deliveryId, status),
        onInterim: words => this.appendInterimWords(bot.id, deliveryId, words),
        onAnswer: text => this.appendInterimWords(bot.id, deliveryId, [{ text, kind: 'answer' }]),
        onTurnEnd: window => this.onTurnEnd({ botId: bot.id, context: 'call', ...window }),
      })
      return { delivery: result.delivery, delivery_id: deliveryId, target }
    } catch (error) {
      await this.appendDeliveryStatus(deliveryId, 'failed')
      throw error
    }
  }

  async enqueueUserTurn(input) {
    const prepared = await this.prepareUserTurn(input)
    const completion = this.startUserTurn(prepared)
    completion.then(reply => this.finishUserTurn(prepared, reply))
      .catch(error => process.stderr.write(`BellTeam user delivery error: ${error.stack ?? error.message}\n`))
    const accepted = await completion.accepted
    return {
      delivery: accepted.delivery, delivery_id: prepared.deliveryId,
      from: 'user', target: prepared.target,
    }
  }

  async userTurn(input) {
    const prepared = await this.prepareUserTurn(input)
    return this.finishUserTurn(prepared, await this.startUserTurn(prepared))
  }

  async prepareUserTurn({ target, message, images = [], recordUser = true }) {
    await this.bots.refresh?.()
    const bot = this.bots.get(target)
    if (!bot) throw new Error(`BOT_NOT_FOUND: ${target}`)
    await this.requireAccess({ from: 'user', target })
    if (typeof message !== 'string' || (message.length === 0 && !images.length)) throw new Error('MESSAGE_REQUIRED')
    images.forEach(validateImage)
    const deliveryId = this.deliveryId()
    const startedAt = this.now()
    if (recordUser) {
      // 送った画像を会話の記録に残す。Botへ渡す一時ファイルはターンが終われば消える。
      const imageAssets = images.length && this.assets ? await this.assets.saveAll({ owner: 'user', id: deliveryId, images }) : []
      await this.append(this.record({
        deliveryId, from: 'user', target, message, images, imageAssets, delivery: 'running',
      }))
    }
    const knownReplyIds = new Set((await this.store.records())
      .filter(record => record.from === target && record.target === 'user')
      .map(record => record.delivery_id))
    return { target, message, images, bot, deliveryId, knownReplyIds, startedAt }
  }

  startUserTurn(prepared) {
    const { target, message, images, bot, deliveryId } = prepared
    return this.transport.turn(bot, userEnvelope(memberIdentity(this.bots, 'user'), message), {
      images,
      queue: {
        context: 'direct', contextId: target, groupId: deliveryId,
        from: 'user', fromName: 'ユーザー', target, message,
      },
      onStatus: status => this.appendDeliveryStatus(deliveryId, status),
      onInterim: words => this.appendInterimWords(target, deliveryId, words),
    })
  }

  async finishUserTurn(prepared, reply) {
    const { target, deliveryId, startedAt } = prepared
    if (reply?.delivery === 'steered') return { delivery: 'steered', delivery_id: deliveryId, from: target, target: 'user' }
    const result = await this.recordUserReply(prepared, reply)
    this.onTurnEnd({ botId: target, context: 'owner', startedAt, endedAt: this.now() })
    return result
  }

  async recordUserReply({ target, deliveryId, knownReplyIds }, reply) {
    const explicitReplies = (await this.store.records())
      .filter(record => record.from === target && record.target === 'user'
        && !knownReplyIds.has(record.delivery_id) && !this.claimedReplyIds.has(record.delivery_id))
    const explicitReply = explicitReplies.at(-1)
    if (explicitReply) {
      this.claimedReplyIds.add(explicitReply.delivery_id)
      return {
        delivery: 'delivered', delivery_id: deliveryId, reply_id: explicitReply.delivery_id,
        from: target, target: 'user', reply: explicitReply.message,
      }
    }
    // Botが回答を空で終えた時（Aiterm 0.54.0から、空の回答は誤りではなく空の本文で届く）は、空の発言を会話へ足さない。
    if (typeof reply !== 'string' || !reply.trim())
      return { delivery: 'delivered', delivery_id: deliveryId, from: target, target: 'user', reply: null }
    const replyId = this.deliveryId()
    this.claimedReplyIds.add(replyId)
    await this.append(this.record({ deliveryId: replyId, from: target, target: 'user', message: reply }))
    return { delivery: 'delivered', delivery_id: deliveryId, reply_id: replyId, from: target, target: 'user', reply }
  }

  record({ deliveryId, from, target, message, images = [], imageAsset = null, imageAssets = [], delivery = 'delivered' }) {
    return {
      schema: 'bellteam.direct-message.v1', delivery_id: deliveryId, at: this.now(),
      from, target, from_identity: memberIdentity(this.bots, from), target_identity: memberIdentity(this.bots, target),
      message, image: images.length > 0, ...(images.length ? { image_count: images.length } : {}), delivery,
      ...(imageAsset ? { image_asset: imageAsset } : {}),
      ...(imageAssets.length ? { image_assets: imageAssets } : {}),
    }
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

  appendDeliveryStatus(deliveryId, delivery) {
    return this.append({
      schema: 'bellteam.delivery-status.v1', delivery_id: deliveryId, at: this.now(), delivery,
    })
  }
}

function validateImage(image) {
  if (typeof image.path === 'string' && image.path.length > 0) return
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mime)) throw new Error('IMAGE_INVALID')
  if (typeof image.data !== 'string' || !/^[a-z0-9+/=]+$/iu.test(image.data)) throw new Error('IMAGE_INVALID')
}
