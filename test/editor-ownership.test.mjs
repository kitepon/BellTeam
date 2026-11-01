import test from 'node:test'
import assert from 'node:assert/strict'
import { createBotEditor } from '../web/bot-editor.js'
import { createRoomEditor } from '../web/room-editor.js'
import { createOwnerEditor } from '../web/owner-editor.js'
import { editorDOM, bot, models, deferred, Element } from './helpers/editor-dom.mjs'
const settle=()=>new Promise(resolve=>setImmediate(resolve))
const callbacks={onSaved:async()=>{},onDeleted:async()=>{},onRestarted(){},onStatus(){},onMemory(){},onSheets(){}}

test('Bot save owns its original target and cannot close or reset a reopened form',async t=>{
 const f=editorDOM(t),pending=deferred(),calls=[],current=[]
 const editor=createBotEditor(f.dialog,{...callbacks,api:async(path,options)=>{
  if(options?.method){calls.push({path,body:JSON.parse(options.body)});return pending.promise}
  return path==='/api/models'?{models}:{bot:bot(path.split('/').at(-1))}
 },onSaved:async(value,isCurrent)=>current.push(isCurrent())})
 await editor.open(bot('a'));f.get('bot-name').value='old A';const saving=f.submit('bot-form');await f.submit('bot-form')
 await editor.open(bot('b'));f.get('bot-name').value='new B'
 pending.resolve({bot:bot('a')});await saving
 assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/bots/a');assert.equal(calls[0].body.name,'old A')
 assert.equal(f.get('bot-name').value,'new B');assert.equal(f.dialog.open,true);assert.deepEqual(current,[false]);assert.equal(f.get('save-bot-button').disabled,false)
})
test('accepted Bot creation becomes an update if catalogue refresh failed; new input is retained',async t=>{
 const f=editorDOM(t),calls=[]
 const editor=createBotEditor(f.dialog,{...callbacks,api:async(path,options)=>{if(options?.method){calls.push({path,method:options.method});return {bot:bot('made')}}return {models}},onSaved:async()=>{throw Error('GET')}})
 f.get('bot-harness').value='codex';await editor.open();f.get('bot-name').value='created';await f.submit('bot-form')
 assert.match(f.get('bot-form-error').textContent,/保存しました/);await f.submit('bot-form')
 assert.deepEqual(calls,[{path:'/api/bots',method:'POST'},{path:'/api/bots/made',method:'PATCH'}])
 assert.equal(f.get('bot-name').value,'created')
})
test('old model catalogue cannot replace a new editor and post-start edits prevent automatic close',async t=>{
 const f=editorDOM(t),old=deferred(),saving=deferred();let modelReads=0
 const editor=createBotEditor(f.dialog,{...callbacks,api:async(path,options)=>{
  if(options?.method)return saving.promise
  if(path==='/api/models')return ++modelReads===1?old.promise:{models}
  return {bot:bot('b')}
 }})
 const first=editor.open(bot('a'));await editor.open(bot('b'));old.resolve({models:{}});await first
 assert.equal(f.get('bot-model').value,'model-a');assert.equal(f.get('bot-model').disabled,false)
 const submitted=f.submit('bot-form');f.get('bot-name').value='new edit';f.get('bot-form').handlers.input()
 saving.resolve({bot:bot('b')});await submitted
 assert.equal(f.get('bot-name').value,'new edit');assert.equal(f.dialog.open,true)
})
test('Room save keeps target/member/representative snapshots and does not reset later edits',async t=>{
 const f=editorDOM(t),pending=deferred(),calls=[];const original=globalThis.Option
 globalThis.Option=class extends Element{constructor(text,value){super();this.textContent=text;this.value=value}}
 t.after(()=>{globalThis.Option=original})
 const editor=createRoomEditor(f.dialog,{api:async(path,request)=>{calls.push({path,body:JSON.parse(request.body)});return pending.promise},getBots:()=>[],onSaved:async()=>{},onDeleted:async()=>{}})
 editor.open({id:'a',name:'A',memberIds:[]});f.get('room-members').querySelectorAll=()=>[{value:'member'}];f.get('room-representative').value='member'
 const saved=f.submit('room-form');await f.submit('room-form')
 editor.open({id:'b',name:'B',memberIds:[]});f.get('room-name').value='new B'
 pending.resolve({room:{id:'a'}});await saved
 assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/rooms/a');assert.deepEqual(calls[0].body.memberIds,['member']);assert.equal(calls[0].body.representativeId,'member')
 assert.equal(f.get('room-name').value,'new B');assert.equal(f.dialog.open,true)
})
function ownerAPI(path,options){
 if(path==='/api/user-rules')return {text:'old rules'}
 if(path==='/api/settings')return {settings:[]}
 if(path==='/api/session')return {authMode:'local'}
 if(path==='/api/harness-auth')return {harnesses:[]}
 return {}
}
test('Owner profile/rules partial success is explicit and submits only captured rules once',async t=>{
 const f=editorDOM(t),pending=deferred(),writes=[],saved=[]
 const editor=createOwnerEditor(f.dialog,{api:async(path,options)=>{
  if(!options?.method)return ownerAPI(path)
  writes.push({path,body:JSON.parse(options.body)})
  if(path==='/api/owner')return pending.promise
  throw Error('RULES_FAILED')
 },onOwner:value=>saved.push(value),onSettings(){}})
 await editor.open({name:'Owner'})
 f.get('user-rules').value='captured rules';const saving=f.submit('owner-form');await f.submit('owner-form')
 f.get('user-rules').value='new unsaved rules';f.get('owner-form').handlers.input()
 pending.resolve({owner:{name:'Saved'}});await saving
 assert.deepEqual(writes.map(x=>x.path),['/api/owner','/api/user-rules']);assert.equal(writes[1].body.text,'captured rules');assert.equal(saved[0].name,'Saved')
 assert.equal(f.get('user-rules').value,'new unsaved rules');assert.match(f.get('owner-form-error').textContent,/プロフィールは保存しました。ユーザー規範を保存できません/);assert.equal(f.dialog.open,true)
})
test('Owner old read/old save cannot overwrite or close a reopened owner form',async t=>{
 const f=editorDOM(t),first=deferred(),write=deferred();let ruleReads=0
 const editor=createOwnerEditor(f.dialog,{api:async(path,options)=>{
  if(options?.method)return path==='/api/owner'?write.promise:{}
  if(path==='/api/user-rules')return ++ruleReads===1?first.promise:{text:'current rules'}
  return ownerAPI(path)
 },onOwner(){},onSettings(){}})
 const old=editor.open({name:'old'});await editor.open({name:'new'});first.resolve({text:'stale'});await old
 assert.equal(f.get('user-rules').value,'current rules');const saving=f.submit('owner-form')
 await editor.open({name:'newer'});f.get('owner-name').value='latest input';write.resolve({owner:{name:'saved'}});await saving
 assert.equal(f.get('owner-name').value,'latest input');assert.equal(f.dialog.open,true)
})
