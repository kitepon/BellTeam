import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { memberIdentity } from './member-identity.mjs'
import { ConversationStore } from './conversation-store.mjs'
import { deliveryExecutionRef } from './execution-bridge.mjs'
import { ConversationWriter } from './conversation-writer.mjs'
import { readImageBytes } from './message-assets.mjs'

export function directEnvelope(from, message) {
  const identity = typeof from === 'string' ? { id: from, name: from, position: '', role: '' } : from
  const name = identity.id === 'user' ? 'オーナー' : identity.name
  return `「${name}」からあなたへ次のメッセージが届いています。\n\n${message}`
}

export function userEnvelope(from, message) {
  return directEnvelope(from, message)
}

export class BellTeamMessenger extends ConversationWriter {
  // onTurnEndは、Botのターンが終わった時にオーナーへの報告漏れを確かめる処理（turn-reports.mjs）を呼ぶ。
  constructor({ bots, transport, logPath, store = new ConversationStore({ logPath }), assets = null, onMessage = () => {}, onTurnEnd = () => {}, requireAccess = async () => {}, admitWork = () => () => {}, now = () => new Date().toISOString(), deliveryId = randomUUID, failureFields }) {
    super({ logPath, now, id: deliveryId, onMessage, failureFields })
    this.bots = bots
    this.transport = transport
    this.assets = assets
    this.onTurnEnd = onTurnEnd
    this.requireAccess = requireAccess
    this.admitWork = admitWork
    this.store = store
    this.claimedReplyIds = new Set()
  }

  // Botの送信（MCP）は画像1枚の `image`、ユーザーの送信は複数枚の `images` で渡す。
  async sendmessage({ from, target, message, image = null, images = image ? [image] : [], executionSource }, { membersLease, admissionCheck } = {}) {
    const check = target === 'user' ? () => {} : this.admitWork()
    await this.bots.refresh?.(membersLease === undefined ? undefined : { membersLease })
    if (!['user', 'scheduler'].includes(from) && !this.bots.has(from)) throw new Error(`SENDER_NOT_FOUND: ${from}`)
    if (target === 'user' && from === 'user') throw new Error('USER_TO_USER_NOT_ALLOWED')
    const bot = target === 'user' ? null : this.bots.get(target)
    if (target !== 'user' && !bot) throw new Error(`BOT_NOT_FOUND: ${target}`)
    if (typeof message !== 'string' || (message.length === 0 && !images.length)) throw new Error('MESSAGE_REQUIRED')
    images.forEach(validateImage)

    if (from === 'user') return this.enqueueUserTurn({ target, message, images })
    if (bot) await this.requireAccess({ from, target })
    if (bot) admissionCheck?.()

    const deliveryId = this.deliveryId()
    const imageAsset = images.length && target === 'user' && this.assets
      ? await this.assets.save({ owner: from, id: deliveryId, image: images[0] })
      : null
    const imageAssets = images.length && bot && this.assets
      ? await this.assets.saveAll({ owner: from, id: deliveryId, images }) : []
    const record = this.record({
      deliveryId, from, target, message, images, imageAsset, imageAssets,
      delivery: bot ? 'running' : 'delivered',
    })
    await this.append(record)
    let delivery = null
    if (bot) {
      try { check() }
      catch (error) { await this.appendDeliveryStatus(deliveryId, 'stopped'); throw error }
      delivery = await this.transport.notify(bot, directEnvelope(memberIdentity(this.bots, from), message), {
        ...(admissionCheck ? { admissionCheck: () => { check(); admissionCheck() } } : {}),
        ...(membersLease === undefined ? {} : { membersLease }),
        ...(executionSource ? { executionSource } : {}),
        images,
        queue: {
          context: 'direct', contextId: bot.id, groupId: deliveryId,
          from, fromName: memberIdentity(this.bots, from).name, target: bot.id, message,
        },
        ...this.notificationCallbacks(bot.id, deliveryId, 'direct'),
      })
    }
    return { delivery: delivery?.delivery ?? 'delivered', delivery_id: deliveryId, from, target }
  }

  async receiveCallBridge({ event, session_id: sessionId, target_id: target, source_system: sourceSystem, source_id: sourceId, source_label: sourceLabel, message, reply_required: replyRequired = true, seq = null }) {
    const check = this.admitWork()
    await this.bots.refresh?.()
    const bot = this.bots.get(target)
    if (!bot) throw new Error(`BOT_NOT_FOUND: ${target}`)
    const from = `call-bridge:${sourceSystem}:${sourceId}`
    await this.requireAccess({ from, target })
    const deliveryId = this.deliveryId()
    const identity = { id: from, name: sourceLabel, position: sourceSystem, role: '通話相手' }
    const record = {
      schema: 'bellteam.direct-message.v1', delivery_id: deliveryId, at: this.now(),
      from, target, from_identity: identity, target_identity: memberIdentity(this.bots, target),
      message, image: false, delivery: 'running', session_id: sessionId,
      call_event: event, call_seq: seq, call_reply_required: replyRequired,
    }
    await this.append(record)
    try {
      check()
      const result = await this.transport.notify(bot, callEnvelope(record), {
        queue: { context: 'direct', contextId: bot.id, groupId: deliveryId, from, fromName: sourceLabel, target: bot.id, message,
          call: { sessionId, event, seq } },
        ...this.notificationCallbacks(bot.id, deliveryId, 'call'),
      })
      return { delivery: result.delivery, delivery_id: deliveryId, target }
    } catch (error) {
      await this.appendDeliveryStatus(deliveryId, ['BOT_STOPPED', 'AI_GLOBAL_PAUSED'].includes(error.code) ? 'stopped' : 'failed', error)
      throw error
    }
  }

  async resumeDelivery(deliveryId, target) {
    const check = this.admitWork()
    await this.bots.refresh?.()
    const record = this.resumableDelivery(deliveryId, await this.store.records())
    const bot = this.bots.get(record.target)
    await this.requireAccess({ from: record.from, target: bot.id })
    const savedImages = record.image_assets ?? (record.image_asset ? [record.image_asset] : [])
    if (record.image && !savedImages.length) throw new Error('IMAGE_ASSET_NOT_FOUND')
    const images = await Promise.all(savedImages.map(async asset => ({ mime: asset.mime,
      data: (await readImageBytes({ path: join(this.assets.directory(asset.owner), asset.file) }, this.assets.maxBytes)).toString('base64') })))
    check()
    const execution = await this.transport.reconcileLaunch(bot, deliveryExecutionRef(deliveryId, target?.session_id), target)
    check()
    const result = await this.transport.notify(bot, record.session_id ? callEnvelope(record)
      : directEnvelope(record.from_identity ?? record.from, record.message), {
      recoveredExecution: execution,
      images,
      queue: { context: 'direct', contextId: bot.id, groupId: deliveryId, from: record.from,
        fromName: record.from_identity?.name ?? record.from, target: bot.id, message: record.message,
        ...(record.session_id ? { call: { sessionId: record.session_id, event: record.call_event, seq: record.call_seq } } : {}) },
      ...this.notificationCallbacks(bot.id, deliveryId, record.session_id ? 'call' : 'direct'),
    })
    return { delivery: result.delivery, delivery_id: deliveryId, from: record.from, target: bot.id }
  }

  async closeDeliveryLaunch(deliveryId, target) {
    const check = this.admitWork()
    await this.bots.refresh?.()
    const record = this.resumableDelivery(deliveryId, await this.store.records())
    const bot = this.bots.get(record.target)
    await this.requireAccess({ from: record.from, target: bot.id })
    check()
    const closed = await this.transport.closeLaunch(bot, deliveryExecutionRef(deliveryId, target?.session_id), target)
    // Keep the original failed history and unknown execution. A new delivery
    // is an explicit separate action by the original sender.
    return { delivery_id: deliveryId, from: record.from, target: bot.id, closed }
  }

  resumableDelivery(deliveryId, records) {
    const record = records.find(row => row.delivery_id === deliveryId)
    if (!record) throw Object.assign(new Error('DELIVERY_NOT_FOUND'), { code: 'DELIVERY_NOT_FOUND', status: 404 })
    if (!['failed', 'unknown'].includes(record.delivery) || !this.bots.has(record.target))
      throw Object.assign(new Error('DELIVERY_NOT_RESUMABLE'), { code: 'DELIVERY_NOT_RESUMABLE', status: 409 })
    return record
  }

  notificationCallbacks(botId, deliveryId, context) {
    return {
      onStatus: (status, error, tracking) => this.appendDeliveryStatus(deliveryId, status, error, tracking),
      onInterim: words => this.appendInterimWords(botId, deliveryId, words),
      onAnswer: text => this.appendInterimWords(botId, deliveryId, [{ text, kind: 'answer' }]),
      onTurnEnd: window => this.onTurnEnd({ botId, context, ...window }),
    }
  }

  async enqueueUserTurn(input) {
    const completion = this.userTurn(input)
    completion.catch(error => process.stderr.write(`BellTeam user delivery error: ${error.stack ?? error.message}\n`))
    return completion.accepted
  }

  userTurn(input) {
    const accepted = Promise.withResolvers()
    // Legacy callers await only completion; a failed admission must not be unhandled.
    accepted.promise.catch(() => {})
    const completion = (async () => {
      const prepared = await this.prepareUserTurn(input)
      const turn = this.startUserTurn(prepared)
      // A legacy transport without accepted only releases the slot at completion.
      Promise.resolve(turn.accepted ?? Promise.resolve(turn).then(reply => ({ delivery: reply?.delivery ?? 'delivered' })))
        .then(result => accepted.resolve({ delivery: result.delivery, delivery_id: prepared.deliveryId,
          from: 'user', target: prepared.target }), accepted.reject)
      return this.finishUserTurn(prepared, await turn)
    })()
    completion.catch(accepted.reject)
    completion.accepted = accepted.promise
    return completion
  }

  async prepareUserTurn({ target, message, images = [], recordUser = true }) {
    const check = this.admitWork()
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
    return { target, message, images, bot, deliveryId, knownReplyIds, startedAt, check }
  }

  startUserTurn(prepared) {
    const { target, message, images, bot, deliveryId } = prepared
    return this.transport.turn(bot, userEnvelope(memberIdentity(this.bots, 'user'), message), {
      admissionCheck: prepared.check,
      images,
      queue: {
        context: 'direct', contextId: target, groupId: deliveryId,
        from: 'user', fromName: 'ユーザー', target, message,
      },
      onStatus: (status, error, tracking) => this.appendDeliveryStatus(deliveryId, status, error, tracking),
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

}

function callEnvelope(record) {
  const identity = record.from_identity
  const party = record.call_event === 'session.reply' ? 'local' : 'member'
  const replyHint = record.call_reply_required === false ? ''
    : `\n\n返信する時は call-bridge MCP の call_send に session_id=${record.session_id}、from_party=${party} を指定して。`
  return `「${identity.name}」（${identity.position}:${record.from.split(':').slice(2).join(':')}）から通話が届いています。session_id=${record.session_id}${record.call_seq == null ? '' : ` seq=${record.call_seq}`}\n\n${record.message}${replyHint}`
}

function validateImage(image) {
  if (typeof image.path === 'string' && image.path.length > 0) return
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mime)) throw new Error('IMAGE_INVALID')
  if (typeof image.data !== 'string' || !/^[a-z0-9+/=]+$/iu.test(image.data)) throw new Error('IMAGE_INVALID')
}
