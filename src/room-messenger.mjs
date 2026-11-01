import { randomUUID } from 'node:crypto'

import { memberIdentity } from './member-identity.mjs'
import { chooseRoomResponder, roomTurnsFromThroughline } from './room-routing.mjs'
import { returnedMcpError } from './returned-mcp-error.mjs'
import { launchFailureDetails } from './agent-launch-error.mjs'

export class RoomMessenger {
  constructor({ rooms, bots, transport, assets = null, onMessage = () => {}, onInterimWords = null, onTurnEnd = () => {}, requireAccess = async () => {}, admitWork = () => () => {}, automaticRouting = () => true, now = () => new Date().toISOString(), messageId = randomUUID, roomTurns = roomTurnsFromThroughline, chooseResponder = chooseRoomResponder }) {
    this.rooms = rooms
    this.bots = bots
    this.transport = transport
    this.assets = assets
    this.onMessage = onMessage
    this.onInterimWords = onInterimWords
    this.onTurnEnd = onTurnEnd
    this.requireAccess = requireAccess
    this.admitWork = admitWork
    this.now = now
    this.messageId = messageId
    this.roomTurns = roomTurns
    this.chooseResponder = chooseResponder
    this.automaticRouting = automaticRouting
    this.roomTasks = new Map()
  }

  sendroommessage(input) {
    let check
    try { check = this.admitWork() } catch (error) { return Promise.reject(error) }
    const previous = this.roomTasks.get(input.room) ?? Promise.resolve()
    const current = previous.then(
      () => this.sendRoomMessageInOrder(input, check),
      () => this.sendRoomMessageInOrder(input, check),
    )
    this.roomTasks.set(input.room, current)
    const clear = () => {
      if (this.roomTasks.get(input.room) === current) this.roomTasks.delete(input.room)
    }
    current.then(clear, clear)
    return current
  }

  // Botの発言（MCP）は画像1枚の `image`、ユーザーの発言は複数枚の `images` で渡す。
  async sendRoomMessageInOrder({ from, room: roomId, message, image = null, images = image ? [image] : [], targets = null, kind = 'message', schedule = null, responseTo = null, executionSource }, check = () => {}) {
    check()
    await Promise.all([this.rooms.refresh?.(), this.bots.refresh?.()])
    const room = this.rooms.get(roomId)
    if (!room) throw new Error(`ROOM_NOT_FOUND: ${roomId}`)
    if (typeof message !== 'string' || (!message.length && !images.length)) throw new Error('MESSAGE_REQUIRED')
    if (!['user', 'scheduler'].includes(from) && !room.memberIds.includes(from)) throw new Error(`ROOM_SENDER_INVALID: ${from}`)
    const manualResponders = targets?.length ? [...new Set(targets)] : null
    if (manualResponders?.some(id => !room.memberIds.includes(id))) throw new Error('ROOM_TARGET_INVALID')
    const automaticRouting = this.automaticRouting()
    if (!manualResponders && !responseTo && room.memberIds.length && !automaticRouting) throw Object.assign(new Error('返信者の自動選択は未設定です。返信するメンバーを選んでください。'), { code: 'ROOM_AUTOMATIC_ROUTING_DISABLED', status: 409 })
    if (responseTo) {
      const posted = (await this.rooms.messages(room.id)).find(item => item.responseTo === responseTo && item.sender.id === from)
      if (posted) return { id: posted.id, room: room.id, targets: posted.routing?.responders ?? [], delivery: 'already_posted' }
    }
    const sender = memberIdentity(this.bots, from)
    await this.requireAccess()
    check()
    const members = room.memberIds.map(id => memberIdentity(this.bots, id))
    const representative = room.representativeId ? memberIdentity(this.bots, room.representativeId) : null
    const snapshot = { id: room.id, name: room.name, purpose: room.purpose, representative, members }
    const deliveryTargets = [...room.memberIds]
    const id = this.messageId()
    const imageAsset = images.length && !['user', 'scheduler'].includes(from) && this.assets
      ? await this.assets.save({ owner: from, id, image: images[0] })
      : null
    const imageAssets = images.length && from === 'user' && this.assets ? await this.assets.saveAll({ owner: 'user', id, images }) : []
    const record = {
      schema: 'bellteam.room-message.v1', id, at: this.now(), kind,
      sender, room: snapshot, targets: manualResponders?.map(id => memberIdentity(this.bots, id)) ?? [],
      message, image: images.length > 0, ...(images.length ? { image_count: images.length } : {}), schedule, ...(responseTo ? { responseTo } : {}),
      routing: { status: 'pending', responders: [] },
      deliveries: deliveryTargets.map(target => ({ target, delivery: 'running' })),
      ...(imageAsset ? { image_asset: imageAsset } : {}),
      ...(imageAssets.length ? { image_assets: imageAssets } : {}),
    }
    await this.rooms.appendMessage(room.id, record)
    this.onMessage(record)
    const failedRouting = async error => {
      const stopped = ['BOT_STOPPED', 'AI_GLOBAL_PAUSED'].includes(error.code)
      await this.rooms.appendMessage(room.id, {
        schema: 'bellteam.room-routing-status.v1', message_id: id,
        routing: stopped ? { status: 'ready', responders: [] } : { status: 'failed', responders: [], error: error.message }, at: this.now(),
      })
      if (stopped) for (const target of deliveryTargets) await this.rooms.appendMessage(room.id, {
        schema: 'bellteam.room-delivery-status.v1', message_id: id, target, at: this.now(), delivery: 'stopped',
      })
    }
    let responders
    try {
      const turns = await this.roomTurns({
        projectPath: this.rooms.roomsRoot, roomId: room.id, messageId: id,
        speaker: sender.name, text: message || '画像',
      })
      // History loading can overlap a global stop. Do not start a routing AI afterwards.
      await this.requireAccess()
      check()
      responders = manualResponders ?? (automaticRouting ? await this.chooseResponder({ room, turns, members }) : [])
      await this.rooms.appendMessage(room.id, {
        schema: 'bellteam.room-routing-status.v1', message_id: id,
        routing: { status: 'ready', responders }, at: this.now(),
      })
    } catch (error) {
      await failedRouting(error)
      throw error
    }
    try { check() } catch (error) { await failedRouting(error); throw error }
    const deliveries = await Promise.allSettled(deliveryTargets.map(id => this.transport.notify(
      this.bots.get(id), roomEnvelope(record, { silent: !responders.includes(id) }), {
        ...(executionSource ? { executionSource } : {}),
        images,
        queue: {
          context: 'room', contextId: room.id, groupId: record.id,
          from, fromName: sender.name, target: id, message,
        },
        onStatus: (delivery, error) => this.rooms.appendMessage(room.id, {
          schema: 'bellteam.room-delivery-status.v1', message_id: record.id,
          target: id, at: this.now(), delivery,
          ...(returnedMcpError(error) ? { mcp_error: returnedMcpError(error) } : {}),
          ...(launchFailureDetails(error) ? { native_launch: launchFailureDetails(error) } : {}),
        }),
        // 合間の言葉と最後の回答は、そのBotの会話画面に出すだけ。ルームにも他のBotにも届けない。
        ...(this.onInterimWords ? {
          onInterim: words => this.onInterimWords(id, record.id, words),
          onAnswer: text => this.onInterimWords(id, record.id, [{ text, kind: 'answer' }]),
        } : {}),
        onTurnEnd: window => this.onTurnEnd({ botId: id, context: 'room', ...window }),
      },
    )))
    const failedTargets = deliveries.flatMap((result, index) => result.status === 'rejected'
      ? [{ id: deliveryTargets[index], error: result.reason?.message ?? String(result.reason) }] : [])
    return {
      id: record.id, room: room.id, targets: responders,
      delivery: failedTargets.length ? 'posted_with_failed_deliveries'
        : deliveries.length === 0 ? 'posted'
          : deliveries.some(item => item.value.delivery === 'running') ? 'running' : 'steered',
      ...(failedTargets.length ? { failedTargets } : {}),
    }
  }
}

export function roomEnvelope(record, { silent = false } = {}) {
  const members = ['オーナー', ...record.room.members.map(member => member.name)]
    .map(name => `「${name}」`).join('、')
  const sender = record.sender.id === 'user' ? 'オーナー' : record.sender.name
  const purpose = record.room.purpose || '未設定'
  const message = `${members}が参加する「${record.room.name}」です。\n\nこの部屋の目的は、\n「${purpose}」\nです。\n\nメッセージID: ${record.id}\n「${sender}」からあなたへ次のメッセージが届いています。\n\n${record.message}`
  return silent ? `${message}\n\nこの発言を読んで部屋の流れを把握し、respond_to_room(action="silent", messageId="${record.id}")だけを呼んでターンを終えてください。部屋や個別チャットへ返答を送らないでください。` : message
}
