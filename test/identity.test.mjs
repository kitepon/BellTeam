import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveBotId } from '../src/identity.mjs'

const bots = new Map([
  ['bell-grok-a', { id: 'bell-grok-a', project: '/srv/bellteam/bots/bell-grok-a' }],
])

test('MCPの送信元をBotのプロジェクトパスから解決する', () => {
  assert.equal(resolveBotId({ cwd: '/srv/bellteam/bots/bell-grok-a', bots }), 'bell-grok-a')
})

test('登録外の作業パスでは送信元を推測しない', () => {
  assert.throws(
    () => resolveBotId({ cwd: '/srv/bellteam/bots/unknown', bots }),
    /BELLTEAM_BOT_ID_UNRESOLVED/,
  )
})
