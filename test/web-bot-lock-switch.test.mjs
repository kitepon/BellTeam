import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createBotEditor } from '../web/bot-editor.js'
import { editorDOM, bot, models } from './helpers/editor-dom.mjs'
const callbacks={onSaved:async()=>{},onDeleted(){},onRestarted(){},onStatus(){},onMemory(){},onSheets(){}}
const setup=(t,existing,writes)=>{
  const f=editorDOM(t)
  const editor=createBotEditor(f.dialog,{...callbacks,api:async(path,options)=>{
    if(options?.method){const body=JSON.parse(options.body);writes.push(body);return{bot:{...existing,...body}}}
    return path==='/api/models'?{models}:{bot:existing}
  }})
  return {f,editor}
}

test('the 固定 switch is in the page, after the fast mode switch', async () => {
  const html=await readFile(new URL('../web/index.html',import.meta.url),'utf8')
  assert.ok(html.indexOf('id="bot-fast-mode"')<html.indexOf('id="bot-configuration-locked"'))
})

test('固定 follows the Bot, is sent only when changed, and never disables the Owner AI controls', async t => {
  const writes=[],existing={...bot('a'),configurationLocked:true}
  const {f,editor}=setup(t,existing,writes)
  await editor.open(existing)
  assert.equal(f.get('bot-configuration-lock-row').hidden,false)
  assert.equal(f.get('bot-configuration-locked').checked,true)
  await f.submit('bot-form')
  assert.equal(Object.hasOwn(writes[0],'configurationLocked'),false)
  await editor.open(existing)
  for (const id of ['bot-harness','bot-model','bot-reasoning-effort']) assert.equal(f.get(id).disabled,false)
  await editor.open(existing)
  f.get('bot-configuration-locked').checked=false
  await f.submit('bot-form')
  assert.equal(writes[1].configurationLocked,false)
  const free={...bot('b'),configurationLocked:false}
  const g=setup(t,free,writes);await g.editor.open(free)
  g.f.get('bot-configuration-locked').checked=true
  await g.f.submit('bot-form')
  assert.equal(writes.at(-1).configurationLocked,true)
})

test('the switch is hidden when the server sends no configurationLocked, and nothing is sent', async t => {
  const writes=[],old=bot('a')
  const {f,editor}=setup(t,old,writes)
  await editor.open(old)
  assert.equal(f.get('bot-configuration-lock-row').hidden,true)
  await f.submit('bot-form')
  assert.equal(Object.hasOwn(writes[0],'configurationLocked'),false)
  await editor.open(null)
  assert.equal(f.get('bot-configuration-lock-row').hidden,true)
})

test('the page carries the agreed caption', async () => {
  const html=await readFile(new URL('../web/index.html',import.meta.url),'utf8')
  assert.ok(html.includes('オンにすると、AIからのCLI・モデル・エフォートの変更を断ります。ここでの変更はそのまま使えます。'))
})

test('a365: a member on a retired AI shows its notice, stays savable, and never sends the notice back', async t => {
  const writes=[],existing={...bot('r'),harness:'antigravity',harnessNotice:'このAIは提供を終了しました。別のAIへ変更してください。'}
  const {f,editor}=setup(t,existing,writes)
  f.get('bot-harness').children=[...['claude','codex','grok','cursor'].map(value=>({value}))]
  await editor.open(existing)
  assert.equal(f.get('bot-configuration-status').textContent,existing.harnessNotice)
  assert.equal(f.get('bot-harness').value,'antigravity')
  assert.ok(f.get('bot-harness').children.some(option=>option.value==='antigravity'))
  await f.submit('bot-form')
  assert.equal(writes[0].harness,'antigravity')
  assert.equal(Object.hasOwn(writes[0],'harnessNotice'),false)
})
