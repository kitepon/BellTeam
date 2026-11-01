import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { createBotEditor } from '../web/bot-editor.js'
import { bot, models } from './helpers/editor-dom.mjs'
import { createOwnerEditor } from '../web/owner-editor.js'
import { editorDOM, deferred } from './helpers/editor-dom.mjs'
const source=await readFile(new URL('../web/app.js',import.meta.url),'utf8')
function catalogue(){
 const reads=[],state={selected:null,selectedType:'bot'},ctx={catalogueRead:0,state,api:path=>{
  if(path.startsWith('/api/bots')){const pending=deferred();reads.push(pending);return pending.promise}
  return Promise.resolve(path==='/api/rooms'?{rooms:[]}:{owner:{name:'old'}})
 },renderOwner(){},renderBots(){},clearSelection(){state.selected=null},conversationTimeline:{updateTarget(){}},app:{classList:{contains:()=>false}}}
 vm.runInNewContext(source.slice(source.indexOf('async function loadBots()'),source.indexOf('\nfunction renderOwner()')),ctx)
 return {ctx,state,reads}
}
test('catalogue latest response keeps selection; stale success and failure are superseded, latest failure rejects',async()=>{
 const {ctx,state,reads}=catalogue();const old=ctx.loadBots(),fresh=ctx.loadBots()
 reads[1].resolve({bots:[{id:'new'}]});assert.equal(await fresh,true);state.selected=state.bots[0]
 reads[0].resolve({bots:[]});assert.equal(await old,null);assert.equal(state.selected.id,'new')
 const failure=ctx.loadBots(),current=ctx.loadBots();reads[3].resolve({bots:[{id:'new'}]});await current
 reads[2].reject(Error('stale'));assert.equal(await failure,null)
 const latest=ctx.loadBots();reads[4].reject(Error('current'));await assert.rejects(latest,/current/);assert.equal(state.selected.id,'new')
})
test('accepted Owner update invalidates catalogue reads already in progress',async()=>{
 const {ctx,state,reads}=catalogue(),old=ctx.loadBots()
 vm.runInNewContext('('+source.match(/onOwner: (owner => \{[^\n]+\})/u)[1]+')({name:"saved"})',ctx)
 reads[0].resolve({bots:[]});assert.equal(await old,null);assert.equal(state.owner.name,'saved')
})
for(const fail of [false,true])test(`unread rules cannot write profile or rules, failed=${fail}`,async t=>{
 const f=editorDOM(t),rules=deferred(),writes=[]
 const editor=createOwnerEditor(f.dialog,{onOwner(){},onSettings(){},api:async(path,options)=>{
  if(options?.method){writes.push({path,body:JSON.parse(options.body)});return {owner:{name:'Owner'}}}
  if(path==='/api/user-rules')return rules.promise
  if(path==='/api/settings')return {settings:[]}
  if(path==='/api/harness-auth')return {harnesses:[]}
  return {}
 }})
 const opening=editor.open({name:'Owner'})
 assert.equal(f.dialog.querySelector('button[form="owner-form"]').disabled,true);assert.equal(f.get('user-rules').disabled,true)
 if(fail){rules.reject(Error('read failed'));await opening}
 await f.submit('owner-form');assert.equal(writes.length,0)
 if(!fail){rules.resolve({text:'existing'});await opening;assert.equal(f.get('user-rules').disabled,false)
  f.get('user-rules').value='';await f.submit('owner-form');assert.equal(writes[1].body.text,'')}
})
test('accepted Bot deletion invalidates older catalogue; ignored response cannot resurrect it',async()=>{
 const {ctx,state,reads}=catalogue();state.bots=[{id:'gone'}]
 const old=ctx.loadBots();ctx.setTimeout=()=>{}
 const start=source.indexOf('onDeleted: async bot => ')+11,end=source.indexOf('\n  onRestarted:',start)
 const callback=source.slice(start,end).trim().replace(/,$/u,'')
 await vm.runInNewContext('('+callback+')({id:"gone"})',ctx)
 reads[0].resolve({bots:[{id:'gone'}]});assert.equal(await old,null);assert.equal(state.bots.length,0)
})

test('Bot deletion remains an acceptance when display callback fails',async t=>{
 const f=editorDOM(t),old=globalThis.window;t.after(()=>{globalThis.window=old});globalThis.window={confirm:()=>true}
 const editor=createBotEditor(f.dialog,{api:async(path,options)=>options?.method?{}:path==='/api/models'?{models}:{bot:bot('a')},onDeleted:async()=>{throw Error('display')},onStatus(){}})
 await editor.open(bot('a'));await f.get('delete-bot-button').handlers.click()
 assert.match(f.get('bot-form-error').textContent,/削除操作を受け付けました/)
})
