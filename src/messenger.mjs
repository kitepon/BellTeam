import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { memberIdentity } from './member-identity.mjs'
import { ConversationStore } from './conversation-store.mjs'
import { deliveryExecutionRef } from './execution-bridge.mjs'
import { ConversationWriter } from './conversation-writer.mjs'
import { readImageBytes } from './message-assets.mjs'

export function directEnvelope(from, message, { fork = false } = {}) {
  const identity = typeof from === 'string' ? { id: from, name: from, position: '', role: '' } : from
  const name = identity.id === 'user' ? 'オーナー' : identity.name
  return `「${name}${fork ? '（分身）' : ''}」からあなたへ次のメッセージが届いています。\n\n${message}`
}

// fork-inquiry.md "Inquiry row and fork input": the fork answers in its last reply, which is relayed; a sendmessage would be a 2nd message.
export function forkInquiryEnvelope(from, message, { fork = false } = {}) {
  const name = `${from.name}${fork ? '（分身）' : ''}`
  return `「${name}」から読み取り専用の問い合わせが届いています。あなたの最後の返答が、そのまま「${name}」へ届きます。答えはsendmessageなどの道具で送らず、最後の返答に書いてください。\n\n${message}`
}

function forkSeatLabel(seat) {
  return seat?.kind === 'fork' && typeof seat.forkId === 'string' && seat.forkId ? { kind: 'fork', fork_id: seat.forkId } : null
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
    // fork-inquiry.md "Owed notice": inquiries whose ONE notice this process holds (live) or still owes (owed).
    // refused: pre-accept refusals whose terminal status write failed; each sweep retries them and they stay live until it succeeds.
    this.forkNotices = { live: new Set(), owed: new Map(), refused: new Map(), scanned: false }
    this.claimedReplyIds = new Set()
  }

  // Botの送信（MCP）は画像1枚の `image`、ユーザーの送信は複数枚の `images` で渡す。
  // askerSeat は seat MCP が解決した分身の席だけが付ける（道具の引数からは来ない）。
  async sendmessage({ executionSource, askerSeat, ...input }, options = {}) {
    const fromSeat = forkSeatLabel(askerSeat)
    const prepared = await this.prepareDirect(input, options, fromSeat ? { from_seat: fromSeat } : null)
    if (prepared.userTurn) return this.enqueueUserTurn(prepared.userTurn)
    return this.notifyDirect(prepared, { ...options, executionSource })
  }

  // sendmessage・ask_readonly・分身の回答中継が共有する、宛先の確認から記録の保存まで。
  // label（分身の印）は入力本文からは受け取らない。
  async prepareDirect({ from, target, message, image = null, images = image ? [image] : [] }, { membersLease, admissionCheck, deliveryId: presetId } = {}, label = null) {
    const check = target === 'user' ? () => {} : this.admitWork()
    await this.bots.refresh?.(membersLease === undefined ? undefined : { membersLease })
    if (!['user', 'scheduler'].includes(from) && !this.bots.has(from)) throw new Error(`SENDER_NOT_FOUND: ${from}`)
    if (target === 'user' && from === 'user') throw new Error('USER_TO_USER_NOT_ALLOWED')
    const bot = target === 'user' ? null : this.bots.get(target)
    if (target !== 'user' && !bot) throw new Error(`BOT_NOT_FOUND: ${target}`)
    if (typeof message !== 'string' || (message.length === 0 && !images.length)) throw new Error('MESSAGE_REQUIRED')
    images.forEach(validateImage)

    if (from === 'user') return { userTurn: { target, message, images } }
    if (bot) await this.requireAccess({ from, target })
    if (bot) admissionCheck?.()

    const deliveryId = presetId ?? this.deliveryId()
    const imageAsset = images.length && target === 'user' && this.assets
      ? await this.assets.save({ owner: from, id: deliveryId, image: images[0] })
      : null
    const imageAssets = images.length && bot && this.assets
      ? await this.assets.saveAll({ owner: from, id: deliveryId, images }) : []
    const record = this.record({
      deliveryId, from, target, message, images, imageAsset, imageAssets,
      delivery: bot ? 'running' : 'delivered', label,
    })
    await this.append(record)
    return { check, bot, deliveryId, from, target, message, images, label }
  }

  async notifyDirect({ check, bot, deliveryId, from, target, message, images, label }, { membersLease, admissionCheck, executionSource } = {}) {
    let delivery = null
    if (bot) {
      try { check() }
      catch (error) { await this.appendDeliveryStatus(deliveryId, 'stopped'); throw error }
      delivery = await this.transport.notify(bot, directEnvelope(memberIdentity(this.bots, from), message, { fork: label?.seat?.kind === 'fork' || label?.from_seat?.kind === 'fork' }), {
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

  // 読み取り専用の問い合わせ。宛先の本体の列には入れず、実行担当の分身へ渡す。受付をすぐ返し、回答は質問者へメッセージで届ける。
  // 質問者が分身の時は、分身は後から届くメッセージを受け取れないので、回答を待って道具の結果で返す。
  async askReadonly({ from, target, message, executionSource, askerSeat }) {
    if (target === 'user') throw Object.assign(new Error('FORK_TARGET_USER'), { code: 'FORK_TARGET_USER', status: 400 })
    const forkId = this.deliveryId()
    const seat = { kind: 'fork', fork_id: forkId }
    const fromSeat = forkSeatLabel(askerSeat)
    // Live from before the inquiry row is durable until its terminal status is: no sweep ever sees it running and not live.
    const deliveryId = this.deliveryId()
    this.forkNotices.live.add(deliveryId)
    // A failed status write leaves the refusal to the next fork.sweep; the tool error stays the refusal.
    const refused = async (status, error, ifRow = false) => {
      const refusal = { deliveryId, status, error, ifRow }
      try { await this.settleForkRefusal(refusal) }
      catch (writeError) {
        this.forkNotices.refused.set(deliveryId, refusal)
        process.stderr.write(`BellTeam fork refusal status error: ${writeError.code ?? writeError.message}\n`)
      }
    }
    let prepared
    try { prepared = await this.prepareDirect({ from, target, message }, { deliveryId }, { seat, ...(fromSeat ? { from_seat: fromSeat } : {}) }) }
    catch (error) { await refused('failed', error, true); throw error }
    const { check, bot } = prepared
    const asker = memberIdentity(this.bots, from)
    const askedAt = this.now()
    try { check() }
    catch (error) { await refused('stopped'); throw error }
    const acceptance = Promise.withResolvers()
    const answered = Promise.withResolvers()
    let relayed = false
    // 回答か失敗のどちらかを一通だけ質問者へ返す。受付前の失敗は道具のエラーとして返すので中継しない。
    // callbackの中で待つ。会話子ではcallbackのACK後にその文脈が閉じ、後から出す中継の作用は拒否されるため。
    // 失敗/回答のcallbackは受付後にしか来ない（起動前の失敗は例外で返る）ので、受付待ちでcallbackが止まらない。
    const relay = text => {
      if (relayed) return
      relayed = true
      if (fromSeat) { this.forkNotices.live.delete(deliveryId); return answered.resolve(text) }
      const notice = { from: bot.id, target: from, message: text, forkId, deliveryId, askedAt, answeredAt: this.now() }
      return acceptance.promise
        .then(accepted => accepted && this.relayForkAnswer(notice))
        .then(() => this.forkNotices.live.delete(deliveryId), error => {
          // The notice stays owed; the next fork.sweep relays it.
          this.forkNotices.live.delete(deliveryId)
          this.forkNotices.owed.set(deliveryId, notice)
          process.stderr.write(`BellTeam fork relay error: ${error.stack ?? error.message}\n`)
        })
    }
    // turn-endは登録しない。報告依頼は本体の席へ届き、本体を中断するため。回答が無い時はdeliveredで知らせる（回答はdeliveredより先に届く）。
    // 分身の途中経過と回答も宛先の会話へ残し、分身の印を付ける。
    const { onStatus } = this.notificationCallbacks(bot.id, deliveryId, 'fork')
    const onInterim = words => this.appendInterimWords(bot.id, deliveryId, words, { seat })
    const onAnswer = text => this.appendInterimWords(bot.id, deliveryId, [{ text, kind: 'answer' }], { seat })
    try {
      const result = await this.transport.forkInquiry(bot, forkInquiryEnvelope(asker, message, { fork: Boolean(fromSeat) }), {
        forkId, deliveryId, ...(executionSource ? { executionSource } : {}),
        queue: { context: 'direct', contextId: bot.id, groupId: deliveryId, from, fromName: asker.name, target: bot.id, message },
        onInterim,
        onStatus: async (status, error, tracking, mark) => {
          const failure = ['failed', 'stopped'].includes(status) && !relayed
            ? `FORK_FAILED: ${error?.reason ?? error?.code ?? error?.message ?? status}` : null
          // The outcome row precedes the failed/stopped status and the relay: every durable boundary still owes the
          // notice, and failed/stopped without it means a refusal before accept (fork-inquiry.md "Owed notice").
          if (failure) await this.appendInterimWords(bot.id, deliveryId, [{ text: failure, kind: 'error' }], { seat })
          await onStatus(status, error, tracking, mark)
          if (failure) await relay(failure)
          if (status === 'delivered') await relay('FORK_FAILED: NO_ANSWER')
        },
        onAnswer: async text => { await onAnswer(text); await relay(text?.trim() ? text : 'FORK_FAILED: NO_ANSWER') },
      })
      acceptance.resolve(true)
      const receipt = { delivery_id: deliveryId, fork_id: forkId, from, target: bot.id, seat: 'fork' }
      if (fromSeat) return { delivery: 'answered', answer: await answered.promise, ...receipt }
      return { delivery: result?.delivery ?? 'running', ...receipt }
    } catch (error) {
      acceptance.resolve(false)
      await refused(['BOT_STOPPED', 'AI_GLOBAL_PAUSED'].includes(error.code) ? 'stopped' : 'failed', error)
      throw error
    }
  }

  // ifRow: a prepareDirect failure settles the inquiry row only if it is durable (an onMessage error after the write).
  async settleForkRefusal({ deliveryId, status, error, ifRow }) {
    if (!ifRow || (await this.store.entries()).some(row => row.schema === 'bellteam.direct-message.v1' && row.delivery_id === deliveryId))
      await this.appendDeliveryStatus(deliveryId, status, error)
    this.forkNotices.live.delete(deliveryId)
  }

  // fork-inquiry.md "Owed notice": relay each owed notice once; the first sweep of a process also scans the log.
  async sweepForkNotices() {
    const notices = this.forkNotices
    for (const [deliveryId, refusal] of [...notices.refused]) {
      if (!notices.refused.delete(deliveryId)) continue // claimed, like an owed notice
      try { await this.settleForkRefusal(refusal) } catch { notices.refused.set(deliveryId, refusal) }
    }
    if (!notices.scanned) {
      const entries = await this.store.entries()
      for (const notice of owedForkNotices(entries))
        if (!notices.live.has(notice.deliveryId) && !notices.owed.has(notice.deliveryId)) notices.owed.set(notice.deliveryId, notice)
      // A row left running by a lost process never gets its status from a callback.
      for (const { deliveryId, delivery } of unsettledForkInquiries(entries)) if (!notices.live.has(deliveryId))
        await this.appendDeliveryStatus(deliveryId, delivery, delivery === 'failed' ? { code: 'FORK_FAILED' } : null)
      notices.scanned = true
    }
    let relayed = 0
    for (const [deliveryId, notice] of [...notices.owed]) {
      // Claim before relaying: an overlapping sweep iterating its own snapshot skips it.
      if (!notices.owed.delete(deliveryId)) continue
      try {
        await this.relayForkAnswer({ ...notice, message: lateForkNotice(notice, this.now()) })
        relayed++
      } catch (error) {
        // Refused before handover. A deleted Bot can never be told; anything else is retried on the next sweep.
        if (!/^(SENDER|BOT)_NOT_FOUND/u.test(error.message ?? '')) notices.owed.set(deliveryId, notice)
        process.stderr.write(`BellTeam fork sweep error: ${error.code ?? String(error.message).split(':')[0]}\n`)
      }
    }
    return { relayed, owed: notices.owed.size }
  }

  // Every refusal (admission, access, unknown Bot) comes before the relay row, so it throws and the notice stays owed,
  // durably too: a restart's scan finds no relay row. Once the row exists the relay is handed over and never resent.
  async relayForkAnswer({ from, target, message, forkId, deliveryId }) {
    const admission = this.admitWork()
    admission()
    const label = { seat: { kind: 'fork', fork_id: forkId }, in_reply_to: deliveryId }
    // prepareDirect runs admissionCheck after its awaits (refresh, access) and right before the row is appended.
    const prepared = await this.prepareDirect({ from, target, message }, { admissionCheck: admission }, label)
    prepared.check = () => {} // a check after the row would leave a stopped relay row that settles the inquiry
    try { return await this.notifyDirect(prepared) }
    catch (error) {
      process.stderr.write(`BellTeam fork relay handed over with error: ${error.code ?? String(error.message).split(':')[0]}\n`)
      return { delivery: 'unknown', delivery_id: prepared.deliveryId }
    }
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
      onStatus: (status, error, tracking, mark) => this.appendDeliveryStatus(deliveryId, status, error, tracking, mark),
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
      onStatus: (status, error, tracking, mark) => this.appendDeliveryStatus(deliveryId, status, error, tracking, mark),
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

  record({ deliveryId, from, target, message, images = [], imageAsset = null, imageAssets = [], delivery = 'delivered', label = null }) {
    return {
      schema: 'bellteam.direct-message.v1', delivery_id: deliveryId, at: this.now(),
      from, target, from_identity: memberIdentity(this.bots, from), target_identity: memberIdentity(this.bots, target),
      message, image: images.length > 0, ...(images.length ? { image_count: images.length } : {}), delivery,
      ...(imageAsset ? { image_asset: imageAsset } : {}),
      ...(imageAssets.length ? { image_assets: imageAssets } : {}),
      ...(label ?? {}),
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

// A sweep relay is late by definition: say when it was asked and answered, so it never reads as current.
export function lateForkNotice({ message, askedAt, answeredAt }, now) {
  const age = Math.max(0, Math.round((Date.parse(now) - Date.parse(answeredAt ?? askedAt)) / 60000))
  const later = age >= 60 ? `${Math.floor(age / 60)}h${String(age % 60).padStart(2, '0')}m` : `${age}m`
  return `FORK_LATE: asked ${jst(askedAt)}, answered ${answeredAt ? jst(answeredAt) : 'never'}, relayed ${later} later. It shows the target's state at that time, not now.\n\n${message}`
}

function jst(iso) {
  return `${new Date(Date.parse(iso) + 9 * 3600000).toISOString().slice(0, 16).replace('T', ' ')} JST`
}

// An inquiry with a main asker and no relay row owes its notice. A post-accept failure saved its text as a fork
// `error` row first; a failed/stopped inquiry without one was refused before accept (already the tool error).
export function unsettledForkInquiries(entries) {
  const answered = new Set(entries.filter(entry => entry.schema === 'bellteam.interim-word.v1' && entry.seat?.kind === 'fork' && entry.kind === 'answer')
    .map(entry => entry.group_id))
  return entries.filter(entry => entry.schema === 'bellteam.direct-message.v1' && entry.seat?.kind === 'fork' && !entry.in_reply_to
    && ['running', 'steered'].includes(entry.delivery))
    .map(entry => ({ deliveryId: entry.delivery_id, delivery: answered.has(entry.delivery_id) ? 'delivered' : 'failed' }))
}

export function owedForkNotices(entries) {
  const relayed = new Set(), answers = new Map(), failures = new Map(), owed = []
  for (const entry of entries) {
    if (entry.schema === 'bellteam.direct-message.v1' && typeof entry.in_reply_to === 'string') relayed.add(entry.in_reply_to)
    if (entry.schema === 'bellteam.interim-word.v1' && entry.seat?.kind === 'fork' && ['answer', 'error'].includes(entry.kind)
      && !(entry.kind === 'error' ? failures : answers).has(entry.group_id)) (entry.kind === 'error' ? failures : answers).set(entry.group_id, entry)
  }
  for (const entry of entries) {
    if (entry.schema !== 'bellteam.direct-message.v1' || entry.seat?.kind !== 'fork' || entry.in_reply_to || entry.from_seat
      || relayed.has(entry.delivery_id)) continue
    const outcome = answers.get(entry.delivery_id) ?? failures.get(entry.delivery_id)
    const message = outcome ? (outcome.text?.trim() ? outcome.text : 'FORK_FAILED: NO_ANSWER')
      : entry.delivery === 'delivered' ? 'FORK_FAILED: NO_ANSWER'
        : ['running', 'steered'].includes(entry.delivery) ? 'FORK_FAILED: INTERRUPTED' : null
    if (message) owed.push({ from: entry.target, target: entry.from, message, forkId: entry.seat.fork_id, deliveryId: entry.delivery_id,
      askedAt: entry.at, ...(outcome ? { answeredAt: outcome.at } : {}) })
  }
  return owed
}
