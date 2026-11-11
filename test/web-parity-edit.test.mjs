import test from 'node:test'
import assert from 'node:assert/strict'
import { createBotEditor } from '../web/bot-editor.js'
import { editorDOM, bot, models } from './helpers/editor-dom.mjs'
const callbacks={onSaved:async()=>{},onDeleted(){},onRestarted(){},onStatus(){},onMemory(){},onSheets(){}}

test('fastMode preserves unchanged true, permits OFF when unavailable and rejects enabling in the UI', async t => {
 const f=editorDOM(t),writes=[]
 const existing={...bot('a'),fastMode:true}
 const catalog={codex:{...models.codex,defaultModel:'model-a',models:[{id:'model-a',efforts:['high'],fast:false}]}}
 const editor=createBotEditor(f.dialog,{...callbacks,api:async(path,options)=>{
   if(options?.method){writes.push(JSON.parse(options.body));return{bot:existing}}
   return path==='/api/models'?{models:catalog}:{bot:existing}
 }})
 await editor.open(existing)
 assert.equal(f.get('bot-fast-mode').disabled,false)
 await f.submit('bot-form')
 assert.equal(Object.hasOwn(writes[0],'fastMode'),false)
 await editor.open(existing)
 f.get('bot-fast-mode').checked=false;f.get('bot-fast-mode').handlers.change()
 assert.equal(f.get('bot-fast-mode').disabled,true)
 await f.submit('bot-form')
 assert.equal(writes[1].fastMode,false)
})

test('lost member save response is verified with GET; subsequent input survives and no PATCH is repeated', async t => {
 const f=editorDOM(t),writes=[];let saved={...bot('a'),fastMode:false},observed=0
 const editor=createBotEditor(f.dialog,{...callbacks,onSaved:async()=>{observed++},api:async(path,options)=>{
  if(options?.method){const body=JSON.parse(options.body);writes.push(body);saved={...saved,...body};throw Error('response lost')}
  return path==='/api/models'?{models}:{bot:saved}
 }})
 await editor.open(saved);f.get('bot-name').value='submitted';await f.submit('bot-form')
 assert.equal(f.get('verify-bot-save').hidden,false)
 f.get('bot-name').value='later';f.get('bot-form').handlers.input()
 await f.get('verify-bot-save').handlers.click()
 assert.equal(writes.length,1);assert.equal(observed,1)
 assert.equal(f.dialog.open,true);assert.equal(f.get('bot-name').value,'later')
 assert.match(f.get('bot-form-error').textContent,/保存を確認/)
})

test('large image edits send only the independent large render/source/crop', async t => {
 const f=editorDOM(t),writes=[];const existing={...bot('a'),avatarLarge:'',avatarSource:'',avatarLargeSource:''}
 const editor=createBotEditor(f.dialog,{...callbacks,api:async(path,options)=>{
  if(options?.method){writes.push(JSON.parse(options.body));return{bot:existing}}
  return path==='/api/models'?{models}:{bot:existing}
 }})
 const image=globalThis.Image;t.after(()=>{globalThis.Image=image})
 globalThis.Image=class{naturalWidth=200;naturalHeight=100;async decode(){}}
 t.mock.method(URL,'createObjectURL',()=> 'blob:fixture');t.mock.method(URL,'revokeObjectURL',()=>{})
 await editor.open(existing)
 f.get('bot-large-crop').width=100;f.get('bot-large-crop').height=100
 f.get('bot-large-file').files=[{}];await f.get('bot-large-file').handlers.change()
 await f.submit('bot-form')
 assert.equal(Object.hasOwn(writes[0],'avatar'),false)
 assert.equal(writes[0].avatarLarge,'data:image/jpeg;base64,bmV3')
 assert.equal(writes[0].avatarLargeSource,'data:image/jpeg;base64,bmV3')
 assert.deepEqual(writes[0].avatarLargeCrop,{x:.25,y:0,width:.5,height:1})
})

test('delete acceptance remains pending; read-only result confirmation never repeats DELETE and closes only on absence', async t => {
 const f=editorDOM(t),oldWindow=globalThis.window;t.after(()=>{globalThis.window=oldWindow});globalThis.window={confirm:()=>true}
 const writes=[],observations=[];let present=true
 const editor=createBotEditor(f.dialog,{...callbacks,onDeleted:async(value,verify=false)=>{observations.push(verify);return present},api:async(path,options)=>{
  if(options?.method){writes.push(options.method);return{deleting:'a'}}
  return path==='/api/models'?{models}:{bot:bot('a')}
 }})
 await editor.open(bot('a'));await f.get('delete-bot-button').handlers.click()
 assert.equal(f.dialog.open,true);assert.equal(f.get('save-bot-button').disabled,true)
 assert.equal(f.get('restart-session-button').disabled,true);assert.equal(f.get('verify-bot-deletion').hidden,false)
 await f.submit('bot-form');assert.deepEqual(writes,['DELETE'])
 await f.get('verify-bot-deletion').handlers.click();assert.equal(f.dialog.open,true)
 assert.match(f.get('bot-deletion-status').textContent,/一覧に残っています/)
 present=false;await f.get('verify-bot-deletion').handlers.click()
 assert.equal(f.dialog.open,false);assert.deepEqual(writes,['DELETE']);assert.deepEqual(observations,[false,true,true])
})

test('model select shows display names while saving ids, and says loading instead of unsupported before /api/models', async t => {
 const f=editorDOM(t),writes=[];let answer
 const existing={...bot('a'),model:'fable',reasoningEffort:'high'}
 const catalog={codex:{...models.codex,models:[{id:'fable',display_name:'Fable 5.2',efforts:['high']},{id:'opus',display_name:'Opus 5.5',efforts:['high']},{id:'claude-opus-5-5',display_name:'Opus 5.5',efforts:['high']},{id:'plain',efforts:['high']}]}}
 const editor=createBotEditor(f.dialog,{...callbacks,api:async(path,options)=>{
  if(options?.method){writes.push(JSON.parse(options.body));return{bot:existing}}
  return path==='/api/models'?new Promise(resolve=>{answer=()=>resolve({models:catalog})}):{bot:existing}
 }})
 const opened=editor.open(existing)
 const labels=id=>f.get(id).children.map(option=>option.textContent)
 assert.deepEqual(labels('bot-model'),['fable（読み込み中…）'])
 assert.deepEqual(labels('bot-reasoning-effort'),['high（読み込み中…）'])
 assert.match(f.get('bot-model-status').textContent,/読み込んでいます/)
 answer();await opened
 assert.deepEqual(labels('bot-model'),['標準','Fable 5.2','Opus 5.5（opus）','Opus 5.5（claude-opus-5-5）','plain','その他（手入力）'])
 assert.equal(f.get('bot-model').value,'fable')
 assert.equal(f.get('bot-model-status').textContent,'')
 await f.submit('bot-form')
 assert.equal(writes[0].model,'fable')
})
