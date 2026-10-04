import assert from 'node:assert/strict'
import test from 'node:test'

import { hasUnreadConversation, newestByRecent } from '../web/activity-order.js'

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
