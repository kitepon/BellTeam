import { objectSchema } from './mcp-schema.mjs'
import { resolveBotImagePath } from './bot-image-path.mjs'
import { requireRoom, requireRoomMember, requireRepresentative } from './room-access.mjs'

export const conversationTools = Object.freeze([
  {
    name: 'sendmessage',
    description: '指定したBellTeam Botまたはuserへ直接メッセージを送る。user宛てで画像を提示する時は、回答全文と画像ファイルパスを一度に渡す。Bot宛てはAitermへ直ちに渡し、Aitermが実行中なら現在のターンへ差し込む。runningまたはsteeredは受付済みなので再送しない。',
    inputSchema: objectSchema({
      target: { type: 'string', minLength: 1, description: '宛先Botの名前、Bot ID、またはuser' },
      message: { type: 'string', minLength: 1, description: '送るメッセージ' },
      image: { type: 'string', minLength: 1, description: '任意の画像ファイルパス' },
    }, ['target', 'message']),
  },
  {
    name: 'send_user_message',
    description: 'ユーザーとして指定したBellTeam Botへメッセージを送り、ユーザーとの会話へ記録する。',
    inputSchema: objectSchema({
      target: { type: 'string', minLength: 1, description: '宛先Bot ID' },
      message: { type: 'string', minLength: 1, description: '送るメッセージ' },
    }, ['target', 'message']),
  },
  {
    name: 'list_messages',
    description: '指定したBotのユーザー会話とBot間連絡の履歴を取得する。',
    inputSchema: objectSchema({ botId: { type: 'string', minLength: 1 } }, ['botId']),
  },
  {
    name: 'list_rooms',
    description: '自分が所属するBellTeamルームを一覧する。',
    inputSchema: objectSchema({}),
  },
  {
    name: 'get_room',
    description: 'ルーム名、目的、代表、メンバーを取得する。',
    inputSchema: objectSchema({ roomId: { type: 'string', minLength: 1 } }, ['roomId']),
  },
  {
    name: 'create_room',
    description: '自分を代表としてBellTeamルームを作る。',
    inputSchema: objectSchema({
      name: { type: 'string', minLength: 1, maxLength: 100 },
      purpose: { type: 'string', maxLength: 8000 },
      memberIds: { type: 'array', items: { type: 'string', minLength: 1 } },
    }, ['name', 'memberIds']),
  },
  {
    name: 'update_room',
    description: '代表としてルーム名、目的、代表、メンバーを変更する。',
    inputSchema: objectSchema({
      roomId: { type: 'string', minLength: 1 },
      name: { type: 'string', minLength: 1, maxLength: 100 },
      purpose: { type: 'string', maxLength: 8000 },
      representativeId: { type: ['string', 'null'] },
      memberIds: { type: 'array', items: { type: 'string', minLength: 1 } },
    }, ['roomId']),
  },
  {
    name: 'delete_room',
    description: '代表としてルームの設定、会話履歴、予定を削除する。',
    inputSchema: objectSchema({ roomId: { type: 'string', minLength: 1 } }, ['roomId']),
  },
  {
    name: 'invite_to_room',
    description: '既存Botをルームへ招待する。botId省略時は自分。',
    inputSchema: objectSchema({
      roomId: { type: 'string', minLength: 1 },
      botId: { type: 'string', minLength: 1 },
    }, ['roomId']),
  },
  {
    name: 'leave_room',
    description: '指定したBotをルームから退出させる。botId省略時は自分。',
    inputSchema: objectSchema({
      roomId: { type: 'string', minLength: 1 },
      botId: { type: 'string', minLength: 1 },
    }, ['roomId']),
  },
  {
    name: 'respond_to_room',
    description: '現在処理中のルーム発言への結果を返す。同時に複数のルーム発言を受けた時は、届いたメッセージIDをmessageIdへ指定する。返信者に指定されたBotはaction=replyと本文を指定する。返信者以外は発言を把握してaction=silentを指定する。silentは表示されず、通常の最終回答もルームへ表示されない。posted_with_failed_deliveriesとalready_postedは投稿済みなので再送しない。',
    inputSchema: objectSchema({
      action: { type: 'string', enum: ['reply', 'silent'] },
      messageId: { type: 'string', minLength: 1, description: '同時に複数受信した場合の返信対象メッセージID' },
      message: { type: 'string', minLength: 1, description: 'action=replyの場合の返答全文' },
      image: { type: 'string', minLength: 1, description: 'action=replyの場合の任意の画像ファイルパス' },
      targets: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'この返信に対して必ず返答するBotを手動で指定する。省略時はJevが決める' },
    }, ['action']),
  },
  {
    name: 'sendroommessage',
    description: '所属ルームへ新しい実質的なメッセージを投稿する。発言は全メンバーへ届く。targets省略時はJevが会話の継続と返信者を決める。targets指定時は指定した全員が返答し、それ以外のメンバーはサイレントに把握する。受信したルーム発言への返答にはrespond_to_roomを使う。',
    inputSchema: objectSchema({
      room: { type: 'string', minLength: 1 },
      message: { type: 'string', minLength: 1 },
      image: { type: 'string', minLength: 1, description: '任意の画像ファイルパス' },
      targets: { type: 'array', items: { type: 'string', minLength: 1 } },
    }, ['room', 'message']),
  },
  {
    name: 'list_queued_messages',
    description: 'BellTeamがAitermへ渡して処理中のメッセージを一覧する。botId指定時はそのBot宛てだけを返す。',
    inputSchema: objectSchema({ botId: { type: 'string', minLength: 1 } }),
  },
  {
    name: 'list_room_messages',
    description: '所属ルームの会話履歴を取得する。',
    inputSchema: objectSchema({ roomId: { type: 'string', minLength: 1 } }, ['roomId']),
  },
])

// 呼出元のidentity・引数キー・台帳refreshは共通MCP入口で確認する。
export async function callConversationTool({ name, args, from, registry, messenger, store, rooms, roomMessenger, deliverMessage, deliverRoomMessage, listQueued }) {
  if (name === 'sendmessage') {
    const { image, ...message } = args
    return (deliverMessage ?? (value => messenger.sendmessage(value)))({
      from, ...message,
      target: args.target === 'user' ? 'user' : resolveBotTarget(registry, args.target),
      image: image ? { path: await resolveBotImagePath(registry.get(from), image) } : null,
    })
  }
  if (name === 'send_user_message') return (deliverMessage ?? (value => messenger.sendmessage(value)))({
    from: 'user', ...args, target: resolveBotTarget(registry, args.target),
  })
  if (name === 'list_messages') {
    requireBot(registry, args.botId)
    return { items: await store.timeline(args.botId) }
  }
  if (name === 'list_rooms') {
    await rooms.refresh()
    return { rooms: [...rooms.values()].filter(room => room.memberIds.includes(from)) }
  }
  if (name === 'get_room') return { room: requireRoomMember(rooms, args.roomId, from) }
  if (name === 'create_room') {
    const memberIds = [...new Set([...args.memberIds, from])]
    return { room: await rooms.create({ name: args.name, purpose: args.purpose ?? '', memberIds, representativeId: from }) }
  }
  if (name === 'update_room') {
    const { roomId, ...changes } = args
    requireRepresentative(rooms, roomId, from)
    return { room: await rooms.update(roomId, changes) }
  }
  if (name === 'delete_room') {
    requireRepresentative(rooms, args.roomId, from)
    await rooms.remove(args.roomId)
    return { removed: args.roomId }
  }
  if (name === 'invite_to_room') {
    const botId = args.botId ?? from
    requireBot(registry, botId)
    const room = requireRoom(rooms, args.roomId)
    return { room: await rooms.update(args.roomId, { memberIds: [...new Set([...room.memberIds, botId])] }) }
  }
  if (name === 'leave_room') {
    const botId = args.botId ?? from
    requireBot(registry, botId)
    const room = requireRoom(rooms, args.roomId)
    return { room: await rooms.update(args.roomId, {
      memberIds: room.memberIds.filter(id => id !== botId),
      representativeId: room.representativeId === botId ? null : room.representativeId,
    }) }
  }
  if (name === 'sendroommessage') {
    const { image, ...message } = args
    return (deliverRoomMessage ?? (value => roomMessenger.sendroommessage(value)))({
      from, ...message,
      ...(args.targets ? { targets: args.targets.map(target => resolveBotTarget(registry, target)) } : {}),
      image: image ? { path: await resolveBotImagePath(registry.get(from), image) } : null,
    })
  }
  if (name === 'respond_to_room') {
    const queue = await listQueued(from)
    const roomMessages = queue.items.filter(item => item.status === 'running' && item.context === 'room')
    if (!args.messageId && roomMessages.length > 1) throw new Error('ROOM_RESPONSE_CONTEXT_AMBIGUOUS')
    let active = roomMessages.find(item => !args.messageId || item.groupId === args.messageId)
    if (!active && args.messageId) {
      await rooms.refresh?.()
      for (const room of rooms.values()) {
        const message = (await rooms.messages(room.id)).find(item => item.id === args.messageId
          && item.deliveries?.some(delivery => delivery.target === from))
        if (message) {
          active = { contextId: room.id, groupId: message.id, from: message.sender.id }
          break
        }
      }
    }
    if (!active) throw new Error('ROOM_RESPONSE_CONTEXT_MISSING')
    const roomId = active.contextId
    requireRoomMember(rooms, roomId, from)
    const received = (await rooms.messages(roomId)).find(item => item.id === active.groupId)
    if (received?.routing?.status !== 'ready') throw new Error('ROOM_ROUTING_NOT_READY')
    const assigned = received.routing.responders.includes(from)
    if (args.action === 'silent') {
      if (args.message || args.image || args.targets) throw new Error('ROOM_SILENT_ARGUMENT_INVALID')
      if (assigned) throw new Error('ROOM_REPLY_EXPECTED')
      return { delivery: 'suppressed' }
    }
    if (args.action !== 'reply') throw new Error('ROOM_REPLY_ACTION_INVALID')
    if (!assigned) throw new Error('ROOM_REPLY_NOT_ASSIGNED')
    if (!args.message && !args.image) throw new Error('ROOM_REPLY_MESSAGE_REQUIRED')
    const { action, image, messageId, ...message } = args
    const replyTargets = args.targets
      ? args.targets.map(target => resolveBotTarget(registry, target))
      : undefined
    const result = await (deliverRoomMessage ?? (value => roomMessenger.sendroommessage(value)))({
      from, room: roomId, responseTo: active.groupId, ...message,
      ...(replyTargets ? { targets: replyTargets } : {}),
      image: image ? { path: await resolveBotImagePath(registry.get(from), image) } : null,
    })
    return { id: result.id, delivery: result.delivery ?? 'posted', ...(result.failedTargets ? { failedTargets: result.failedTargets } : {}) }
  }
  if (name === 'list_queued_messages') return listQueued(args.botId)
  if (name === 'list_room_messages') {
    requireRoomMember(rooms, args.roomId, from)
    return { items: await rooms.messages(args.roomId) }
  }
  throw new Error(`TOOL_NOT_FOUND: ${name}`)
}

function requireBot(registry, id) {
  const bot = registry.get(id)
  if (!bot) throw new Error(`BOT_NOT_FOUND: ${id}`)
  return bot
}

function resolveBotTarget(registry, target) {
  if (registry.has(target)) return target
  const matches = [...registry.values()].filter(bot => bot.name === target || bot.displayName === target)
  if (matches.length === 1) return matches[0].id
  if (matches.length > 1) throw new Error(`BOT_TARGET_AMBIGUOUS: ${target}`)
  throw new Error(`BOT_NOT_FOUND: ${target}`)
}
