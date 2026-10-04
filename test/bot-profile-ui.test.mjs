import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Bot設定は人格の3欄と、その後に一行の役職・役割を持つ', async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8')
  const personality = html.indexOf('id="bot-personality"')
  const profile = html.indexOf('id="bot-profile-text"')
  const speech = html.indexOf('id="bot-speech-style"')
  const position = html.indexOf('<input id="bot-position" name="position"')
  const role = html.indexOf('id="bot-role"')

  assert.ok(profile >= 0)
  assert.ok(personality > profile)
  assert.ok(speech > personality)
  assert.ok(position > speech)
  assert.ok(role > position)
  assert.doesNotMatch(html, /bot-title|name="title"|肩書き/u)
})

test('Bot設定は作成後もモデルとエフォートを選べる', async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8')
  const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')

  assert.match(html, /<select id="bot-model"/u)
  assert.match(html, /id="bot-model-custom"/u)
  assert.match(html, /id="bot-reasoning-effort"/u)
  assert.match(app, /function selectableEfforts\(\)/u)
  assert.match(app, /このモデルでは未対応/u)
  assert.match(app, /model: selectedModel\(\)/u)
  assert.match(app, /その他（手入力）/u)
  assert.match(app, /reasoningEffort: botReasoningEffort\.value/u)
})

test('チャット上部はBotの役割本文を表示しない', async () => {
  const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')

  assert.match(app, /chatStatus\.textContent = bot\.online \? 'オンライン' : '待機中 · 送信時に起動'/u)
  assert.doesNotMatch(app, /chatStatus\.textContent = \[[^\n]*bot\.role/u)
})
