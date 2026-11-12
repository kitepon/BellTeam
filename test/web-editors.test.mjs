import test from 'node:test'
import assert from 'node:assert/strict'
import { roomSaveError } from '../web/room-editor.js'

test('room save refusals read in plain words; unknown ones ask to retry (W79)', () => {
  assert.match(roomSaveError({ code: 'ROOM_NAME_INVALID' }), /ルーム名/)
  assert.match(roomSaveError(new Error('ROOM_REPRESENTATIVE_INVALID')), /代表は参加メンバーから/)
  assert.match(roomSaveError({ code: 'ROOM_MEMBERS_INVALID' }), /いないメンバー/)
  assert.match(roomSaveError(new Error('network')), /通信を確かめて/)
  assert.doesNotMatch(roomSaveError({ code: 'ROOM_PURPOSE_INVALID' }), /[A-Z_]{5,}/)
})
