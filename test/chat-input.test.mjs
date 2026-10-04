import assert from 'node:assert/strict'
import test from 'node:test'
import { claimMessageSend, claimSingleFlight, linkifyHtml, readApiError, readApiResponse, releaseSingleFlight, sendFailureText } from '../web/chat-input.js'

test('送信中は同じ送信処理へ二度入らない', () => {
  const state = { sending: new Set() }
  assert.deepEqual(claimMessageSend(state, 'bot:bot-a', ' こんにちは ', []), { message: 'こんにちは', pendingImages: [] })
  assert.equal(claimMessageSend(state, 'bot:bot-a', 'こんにちは', []), null)
  assert.deepEqual(claimMessageSend(state, 'bot:bot-b', 'こんにちは', []), { message: 'こんにちは', pendingImages: [] })
})

test('本文が空でも画像があれば送信でき、どちらも無ければ送信しない', () => {
  const state = { sending: new Set() }
  const images = [{ file: 'a' }, { file: 'b' }]
  assert.equal(claimMessageSend(state, 'bot:bot-a', '  ', []), null)
  const claimed = claimMessageSend(state, 'bot:bot-a', '', images)
  assert.deepEqual(claimed, { message: '', pendingImages: images })
  assert.notEqual(claimed.pendingImages, images)
})

test('保存中は同じフォーム処理へ二度入らず、完了後は再実行できる', () => {
  const inFlight = new Set()
  assert.equal(claimSingleFlight(inFlight, 'bot-save'), true)
  assert.equal(claimSingleFlight(inFlight, 'bot-save'), false)
  releaseSingleFlight(inFlight, 'bot-save')
  assert.equal(claimSingleFlight(inFlight, 'bot-save'), true)
})

test('APIの具体的なエラーを画面へ返す', async () => {
  assert.equal(await readApiError(new Response('{"error":"BOT_AVATAR_INVALID"}', {
    status: 400, headers: { 'content-type': 'application/json' },
  })), 'BOT_AVATAR_INVALID')
  assert.equal(await readApiError(new Response('', { status: 502 })), 'HTTP_502')
})

test('本文のない成功応答をエラーにしない', async () => {
  assert.equal(await readApiResponse(new Response(null, { status: 204 })), null)
  assert.deepEqual(await readApiResponse(new Response('{"ok":true}', {
    status: 200, headers: { 'content-type': 'application/json' },
  })), { ok: true })
})

test('本文のURLだけを別タブで開くリンクにし、それ以外はエスケープする', () => {
  assert.equal(
    linkifyHtml('見て https://example.com/article 。<b>太字</b>'),
    '見て <a href="https://example.com/article" target="_blank" rel="noopener noreferrer">https://example.com/article</a> 。&lt;b&gt;太字&lt;/b&gt;',
  )
  assert.equal(
    linkifyHtml('（https://x.com/qlyun35332）'),
    '（<a href="https://x.com/qlyun35332" target="_blank" rel="noopener noreferrer">https://x.com/qlyun35332</a>）',
  )
  assert.equal(linkifyHtml('リンクなし'), 'リンクなし')
})

test('送信の拒否は理由付きの一行にする', () => {
  assert.equal(sendFailureText('ROOM_REPRESENTATIVE_REQUIRED'), '送信できませんでした（ROOM_REPRESENTATIVE_REQUIRED）')
  assert.equal(sendFailureText('HTTP_502'), '送信できませんでした。サーバーが応答しませんでした（HTTP_502）')
})
