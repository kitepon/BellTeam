import assert from 'node:assert/strict'
import test from 'node:test'

import { hasUnreadConversation, newestByRecent, pinnedFirst } from '../web/activity-order.js'

test('メンバーとルームを最後のアクションが新しい順へ並べる', () => {
  const items = [
    { id: 'none', recent: null },
    { id: 'middle', recent: { at: '2026-09-02T09:00:00.000Z' } },
    { id: 'newest', recent: { at: '2026-09-02T10:00:00.000Z' } },
    { id: 'invalid', recent: { at: 'invalid' } },
  ]

  assert.deepEqual(newestByRecent(items).map(item => item.id), ['newest', 'middle', 'none', 'invalid'])
  assert.deepEqual(items.map(item => item.id), ['none', 'middle', 'newest', 'invalid'])
})

test('同時刻とアクションなしは元の安定順を保つ', () => {
  const at = '2026-09-02T10:00:00.000Z'
  const items = [
    { id: 'first', recent: { at } },
    { id: 'second', recent: { at } },
    { id: 'none-a' },
    { id: 'none-b', recent: null },
  ]

  assert.deepEqual(newestByRecent(items).map(item => item.id), ['first', 'second', 'none-a', 'none-b'])
})

test('既読は並び順に使わず、Botからユーザーへの返答だけ未読にする', () => {
  const botReply = { recent: { id: 'reply-2', kind: 'message', direction: 'incoming' } }
  const ownMessage = { recent: { id: 'message-2', kind: 'message', direction: 'outgoing' } }
  const peerAction = { recent: { id: 'peer-2', kind: 'peer', direction: 'received' } }
  const roomReply = { recent: { id: 'room-2', sender: { id: 'bot-a' } } }
  const ownRoomMessage = { recent: { id: 'room-user-2', sender: { id: 'user' } } }

  assert.equal(hasUnreadConversation(botReply, 'bot', 'reply-1'), true)
  assert.equal(hasUnreadConversation(botReply, 'bot', 'reply-2'), false)
  assert.equal(hasUnreadConversation(ownMessage, 'bot', null), false)
  assert.equal(hasUnreadConversation(peerAction, 'bot', null), false)
  assert.equal(hasUnreadConversation(roomReply, 'room', null), true)
  assert.equal(hasUnreadConversation(ownRoomMessage, 'room', null), false)
})

test('a480: ピン済みを先頭へ、ピンした順（同時刻はid順）に並べ、残りは来た順のまま。pinnedを送らない古い本体は未ピン', () => {
  const items = [
    { id: 'a' }, { id: 'c', pinnedAt: '2026-11-21T09:10:00.000Z' }, { id: 'b', pinnedAt: '2026-11-21T09:10:00.000Z' },
    { id: 'd', pinnedAt: null }, { id: 'e', pinnedAt: '2026-11-21T09:05:00.000Z' }, { id: 'f', pinnedAt: 'invalid' },
  ]
  assert.deepEqual(pinnedFirst(items).map(item => item.id), ['e', 'b', 'c', 'a', 'd', 'f'])
  assert.deepEqual(items.map(item => item.id), ['a', 'c', 'b', 'd', 'e', 'f'])
  assert.deepEqual(pinnedFirst([]), [])
})
