import { join } from 'node:path'
import { ConversationStore } from './conversation-store.mjs'
import { BellTeamMessenger } from './messenger.mjs'
import { MessageAssets } from './message-assets.mjs'
import { RoomMessenger } from './room-messenger.mjs'
import { RoomRegistry } from './room-registry.mjs'
import { TurnReports, judgeOwnerReport } from './turn-reports.mjs'
import { SeatTurns } from './seat-turns.mjs'
import { SelfTurns, readObserverTurns } from './self-turns.mjs'
import { checkObserverProjects } from './observer-check.mjs'
import { chooseRoomResponder } from './room-routing.mjs'

// 最初に直接会話を接続し、初期案内の初期化後に観測と部屋を初期化する。
export function createConversationServices({ root, bots, transport, notifications, aiControl, settings, seatRuntime = null,
  readRemovalStates = () => bots.readRemovalStates() }) {
  let turnReports
  const logPath = join(root, 'logs/direct-messages.jsonl')
  const store = new ConversationStore({ logPath })
  const assets = new MessageAssets({ root, readRemovalStates, ...(seatRuntime ? {
    botsAssetsRoot: join(root, 'state/bots'),
    readImage: (image, maxBytes) => seatRuntime.readImage(image, maxBytes),
  } : {}) })
  const messenger = new BellTeamMessenger({
    bots, transport, logPath, store, assets,
    admitWork: () => aiControl.admit(),
    requireAccess: () => aiControl.assertEnabled(),
    onMessage: record => notifications.direct(record),
    onTurnEnd: turn => turnReports.afterTurn(turn),
  })
  const initialize = async () => {
    await assets.initialize()
    turnReports = new TurnReports({
      bots, store, transport,
      enabled: () => !aiControl.paused && settings.configuration('routing').enabled,
      judge: value => judgeOwnerReport({ ...value, apiKey: settings.configuration('routing').apiKey }),
      appendInterimWords: (botId, groupId, words) => messenger.appendInterimWords(botId, groupId, words),
    })
    // ハーネスが自分から始めたターンは配送を通らないので、Throughlineの記録から拾って会話画面へ出す。
    const selfTurns = new SelfTurns({
      bots, statePath: join(root, 'logs/self-turns.json'),
      appendAnswer: (botId, groupId, text) => messenger.appendInterimWords(botId, groupId, [{ text, kind: 'answer' }]),
      afterTurn: turn => turnReports.afterTurn(turn),
      shown: botId => transport.shownInSelfTurn(botId),
      read: (request, options) => readObserverTurns(request, { ...options, seatCommands: Boolean(seatRuntime) }),
      check: (request, options) => checkObserverProjects(request, { ...options, root, seatCommands: Boolean(seatRuntime) }),
    })
    await selfTurns.initialize()
    // BellTeamが始めていないターンも、Aitermに席の今のターンを聞いて「処理中」と合間の言葉に出す。
    const seatTurns = new SeatTurns({
      bots, transport,
      appendInterimWords: (botId, groupId, words) => messenger.appendInterimWords(botId, groupId, words),
    })
    const rooms = new RoomRegistry({ roomsRoot: join(root, 'rooms'), bots })
    await rooms.initialize()
    const roomMessenger = new RoomMessenger({
      rooms, bots, transport, assets,
      admitWork: () => aiControl.admit(),
      requireAccess: () => aiControl.assertEnabled(),
      automaticRouting: () => settings.configuration('routing').enabled,
      chooseResponder: value => chooseRoomResponder({ ...value, apiKey: settings.configuration('routing').apiKey }),
      onMessage: record => notifications.room(record),
      onInterimWords: (botId, groupId, words) => messenger.appendInterimWords(botId, groupId, words),
      onTurnEnd: turn => turnReports.afterTurn(turn),
    })
    return { selfTurns, seatTurns, rooms, roomMessenger }
  }
  return { store, assets, messenger, initialize }
}
