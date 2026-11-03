import test from 'node:test'
import assert from 'node:assert/strict'
import { matchesMemberQuery, matchesRoomQuery } from '../web/roster-search.js'
import { guardEditorClose, requestEditorClose } from '../web/editor-close.js'

test('member and room searches combine words, normalized names and actual member positions', () => {
  const bots = [{ id:'a', name:'Ａｄｍｉ', displayName:'アドミ', position:'Web アプリ' }, { id:'b', name:'モリー', position:'共通 API' }]
  assert.equal(matchesMemberQuery(bots[0], 'admi web'), true)
  assert.equal(matchesMemberQuery(bots[0], '共通'), false)
  const room = { name:'開発', memberIds:['b'] }
  assert.equal(matchesRoomQuery(room, bots, '開発 api'), true)
  assert.equal(matchesRoomQuery(room, bots, 'web'), false)
  assert.equal(matchesRoomQuery(room, bots, ''), true)
})

test('only user close asks about dirty inputs; rejected discard retains the dialog', t => {
  const old = globalThis.confirm
  t.after(() => { globalThis.confirm = old })
  const dialog = new EventTarget()
  dialog.open = true
  dialog.close = () => { dialog.open = false }
  let dirty = false, saving = false, prompts = []
  globalThis.confirm = text => { prompts.push(text); return false }
  guardEditorClose(dialog, () => dirty, () => saving)
  dirty = true
  requestEditorClose(dialog)
  assert.equal(dialog.open, true)
  assert.match(prompts.at(-1), /未保存/)
  saving = true
  requestEditorClose(dialog)
  assert.match(prompts.at(-1), /保存処理中/)
  dialog.close() // accepted save closes directly
  assert.equal(prompts.length, 2)
  dialog.open = true; dirty = false; saving = false
  requestEditorClose(dialog)
  assert.equal(dialog.open, false)
  assert.equal(prompts.length, 2)
})

test('schedule overview rejects missing and duplicate sources instead of displaying an empty success', async () => {
  const { checkedScheduleSources } = await import('../web/schedules-overview.js')
  const targets=[{type:'bot',id:'a'},{type:'room',id:'r'}]
  const source=(kind,id)=>({kind,id,schedules:[]})
  assert.equal(checkedScheduleSources([source('bot','a'),source('room','r')],targets).length,2)
  assert.throws(()=>checkedScheduleSources([source('bot','a')],targets),/一部/)
  assert.throws(()=>checkedScheduleSources([source('bot','a'),source('bot','a')],targets),/不正/)
  assert.throws(()=>checkedScheduleSources([source('other','r')],[]),/不正/)
})

test('browser server switch accepts the same local transports and strips paths, while refusing credentials', async () => {
  const { serverDestination } = await import('../web/server-origin.js')
  assert.equal(serverDestination('https://example.com/path?q=secret'), 'https://example.com')
  assert.equal(serverDestination('http://127.0.0.1:4181'), 'http://127.0.0.1:4181')
  assert.throws(()=>serverDestination('https://user:password@example.com'))
  assert.throws(()=>serverDestination('http://public.example.com'))
  assert.throws(()=>serverDestination('javascript:alert(1)'))
})
