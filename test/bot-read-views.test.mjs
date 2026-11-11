import test from 'node:test'
import assert from 'node:assert/strict'
import { createScreenView, createCharacterSheetView } from '../web/bot-read-views.js'
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
const settle=()=>new Promise(resolve=>setImmediate(resolve))
class Element {
 children=[];style={};listeners={};dataset={};hidden=true;scrollHeight=100;scrollTop=0;clientHeight=100;clientWidth=500
 setAttribute(name,value){this[name]=value}
 append(...nodes){this.children.push(...nodes)}
 replaceChildren(...nodes){this.children=nodes}
 addEventListener(name,fn){this.listeners[name]=fn}
 remove(){}
 getBoundingClientRect(){return {width:400}}
 showModal(){this.open=true}
 close(){this.open=false;this.listeners.close()}
}
const original={document:globalThis.document,window:globalThis.window}
function platform(t){
 globalThis.document={createElement:()=>new Element(),body:new Element()};globalThis.window={addEventListener(){}}
 t.after(()=>Object.assign(globalThis,original))
}
test('closing an initial screen read cannot recreate its timer or apply a late result',async t=>{
 platform(t);let timers=0;t.mock.method(globalThis,'setTimeout',()=>{timers++;return 1});t.mock.method(globalThis,'clearTimeout',()=>{})
 const pending=deferred(),panel=new Element(),status=new Element(),text=new Element()
 const view=createScreenView({panel,status,text,header:{offsetHeight:80},api:()=>pending.promise})
 const opened=view.open({id:'a',displayName:'A'});view.close();pending.resolve({online:true,screen:'old'});await opened
 assert.equal(timers,0);assert.equal(panel.hidden,true);assert.equal(text.textContent,'')
})
test('screen reopening owns its result and only creates one current timer',async t=>{
 platform(t);let timers=0;t.mock.method(globalThis,'setTimeout',()=>{timers++;return 1});t.mock.method(globalThis,'clearTimeout',()=>{})
 const a=deferred(),b=deferred(),panel=new Element(),status=new Element(),text=new Element()
 const view=createScreenView({panel,status,text,header:{offsetHeight:80},api:path=>path.includes('/a/')?a.promise:b.promise})
 const first=view.open({id:'a',displayName:'A'}),second=view.open({id:'b',displayName:'B'})
 b.resolve({online:true,screen:'B screen  '});await second;a.reject(Error('A failure'));await first
 assert.equal(text.textContent,'B screen');assert.match(status.textContent,/Bの画面/);assert.equal(timers,1)
})
test('late character sheet bytes after close create no URL and old list cannot populate a new dialog',async t=>{
 platform(t);let creates=0;t.mock.method(URL,'createObjectURL',()=>{creates++;return 'blob:a'});t.mock.method(URL,'revokeObjectURL',()=>{})
 const pending=deferred(),dialog=new Element(),list=new Element()
 const view=createCharacterSheetView(dialog,list,{api:async()=>({sheets:[{file:'sheet',url:'/image'}]}),fetchImage:()=>pending.promise})
 const opened=view.open({id:'a'});await settle();dialog.close();pending.resolve(new Response(new Blob(['x'])));await opened
 assert.equal(creates,0)
 const old=deferred();const fresh=createCharacterSheetView(dialog,list,{api:path=>path.includes('/a/')?old.promise:Promise.resolve({sheets:[]})})
 const first=fresh.open({id:'a'});await fresh.open({id:'b'});old.resolve({sheets:[{file:'old'}]});await first
 assert.equal(list.children.length,1);assert.equal(list.children[0].textContent,'まだ置かれていない。')
})
test('partial character sheet failure releases prior URLs and close does not release twice',async t=>{
 platform(t);const revoked=[];t.mock.method(URL,'createObjectURL',()=> 'blob:a');t.mock.method(URL,'revokeObjectURL',url=>revoked.push(url))
 const dialog=new Element(),list=new Element()
 const view=createCharacterSheetView(dialog,list,{api:async()=>({sheets:[{file:'one',url:'/one'},{file:'two',url:'/two'}]}),fetchImage:async path=>new Response(new Blob(['x']),{status:path==='/one'?200:500})})
 await view.open({id:'a'});assert.deepEqual(revoked,['blob:a']);assert.match(list.children[0].textContent,/読めません/)
 dialog.close();assert.deepEqual(revoked,['blob:a'])
})

const all=(node,match)=>[...(match(node)?[node]:[]),...(node.children??[]).flatMap(child=>all(child,match))]
const words=node=>[node.textContent??'',...(node.children??[]).map(words)].join(' ')
function inputFixture(t,respond){
 platform(t);t.mock.method(globalThis,'setTimeout',()=>1);t.mock.method(globalThis,'clearTimeout',()=>{})
 const calls=[],panel=new Element(),status=new Element(),text=new Element(),input=new Element()
 const view=createScreenView({panel,status,text,input,header:{offsetHeight:80},api:async(path,options)=>{calls.push({path,body:options?.body?JSON.parse(options.body):null});return respond(path,options)}})
 const key=name=>all(input,node=>node.dataset?.screenKey===name)[0]
 const decision=name=>all(input,node=>node.dataset?.screenDecision===name)[0]
 return {view,calls,input,key,decision,posts:()=>calls.filter(call=>call.body),note:()=>words(input)}
}
const screen=()=>({online:true,screen:'claude> '})
const failure=(code,status)=>Object.assign(Error(code),{code,status})
test('key bar sends one closed-set key per tap to the opened Bot and re-reads the screen',async t=>{
 const f=inputFixture(t,path=>path.endsWith('/approval')?{status:'none'}:path.endsWith('/key')?{key:'Enter',outcome:'accepted'}:screen())
 await f.view.open({id:'a',displayName:'A'})
 assert.equal(f.input.hidden,false)
 assert.deepEqual(all(f.input,node=>node.dataset?.screenKey).map(node=>node.dataset.screenKey),['Escape','Tab','Up','Down','Left','Right','Enter','1','2','3','4','5','6','7','8','9','0','C-c'])
 const reads=f.calls.length;f.key('Enter').listeners.click();f.key('Enter').listeners.click();await settle();await settle()
 assert.deepEqual(f.posts(),[{path:'/api/bots/a/screen/key',body:{key:'Enter'}}])
 assert.match(f.note(),/Enter を送りました/);assert.ok(f.calls.length>reads+1)
})
test('approval card shows only the returned labels and answers with the read digest; changes are not retried',async t=>{
 let changed=false
 const f=inputFixture(t,(path,options)=>{
  if(path.endsWith('/approval')&&options?.method==='POST'){if(changed)throw failure('SCREEN_APPROVAL_CHANGED',409);return {status:'submitted',decision:'approve_once'}}
  if(path.endsWith('/approval'))return {status:'approval_required',promptDigest:'sha256:'+'a'.repeat(64),choices:[{decision:'approve_once',label:'はい'},{decision:'deny',label:'いいえ'},{decision:'approve_always',label:'常に'}]}
  return screen()})
 await f.view.open({id:'a',displayName:'A'})
 assert.equal(f.decision('approve_once').textContent,'はい');assert.equal(f.decision('deny').textContent,'いいえ');assert.equal(f.decision('approve_always'),undefined)
 changed=true;f.decision('approve_once').listeners.click();await settle();await settle()
 assert.deepEqual(f.posts(),[{path:'/api/bots/a/screen/approval',body:{decision:'approve_once',promptDigest:'sha256:'+'a'.repeat(64)}}])
 assert.match(f.note(),/確認の内容が変わりました/)
})
test('older body (503) hides the bar until reopen; failed sends show plain words and are not retried',async t=>{
 let mode='unavailable'
 const f=inputFixture(t,path=>{
  if(path.endsWith('/approval'))return {status:'none'}
  if(path.endsWith('/key'))throw mode==='unavailable'?failure('SCREEN_INPUT_UNAVAILABLE',503):failure('SCREEN_INPUT_FAILED',502)
  return screen()})
 await f.view.open({id:'a',displayName:'A'})
 f.key('Escape').listeners.click();await settle();await settle()
 assert.equal(f.input.hidden,true)
 mode='failed';await f.view.open({id:'a',displayName:'A'});assert.equal(f.input.hidden,false)
 const before=f.posts().length;f.key('C-c').listeners.click();await settle();await settle()
 assert.equal(f.posts().length,before+1);assert.match(f.note(),/届いたか確認できませんでした/);assert.doesNotMatch(f.note(),/SCREEN_/)
})
test('a key reply after close or reopen for another Bot is dropped',async t=>{
 const pending=deferred()
 const f=inputFixture(t,path=>path.endsWith('/key')?pending.promise:path.endsWith('/approval')?{status:'none'}:screen())
 await f.view.open({id:'a',displayName:'A'});f.key('Tab').listeners.click()
 await f.view.open({id:'b',displayName:'B'});pending.resolve({key:'Tab',outcome:'accepted'});await settle();await settle()
 assert.doesNotMatch(f.note(),/送りました/);assert.equal(f.key('Tab').disabled,false)
})
test('screen reads run every 1 s after the previous returns and never overlap',async t=>{
 platform(t);const ticks=[];t.mock.method(globalThis,'setTimeout',(fn,ms)=>{ticks.push({fn,ms});return ticks.length});t.mock.method(globalThis,'clearTimeout',()=>{})
 const gate=deferred();let screens=0,open=0,max=0
 const panel=new Element(),status=new Element(),text=new Element(),input=new Element()
 const view=createScreenView({panel,status,text,input,header:{offsetHeight:80},api:async(path,options)=>{
  if(path.endsWith('/key'))return {key:'Enter',outcome:'accepted'}
  if(path.endsWith('/approval'))return {status:'none'}
  screens++;open++;max=Math.max(max,open);if(screens===2)await gate.promise;open--;return {online:true,screen:'s'}}})
 await view.open({id:'a',displayName:'A'})
 assert.deepEqual(ticks.map(tick=>tick.ms),[1000]);assert.match(status.textContent,/1秒ごと/)
 const next=ticks[0].fn();await settle()
 assert.equal(screens,2);assert.equal(ticks.length,1)
 const key=all(input,node=>node.dataset?.screenKey==='Enter')[0];key.listeners.click();await settle();await settle()
 assert.equal(screens,2);assert.equal(max,1)
 gate.resolve();await next;await settle()
 assert.equal(screens,3);assert.equal(max,1);assert.deepEqual(ticks.map(tick=>tick.ms),[1000,1000])
})
test('a stopped member gets no key bar and the panel says it starts with the next message (W26)',async t=>{
 platform(t);t.mock.method(globalThis,'setTimeout',()=>1);t.mock.method(globalThis,'clearTimeout',()=>{})
 const panel=new Element(),status=new Element(),text=new Element(),input=new Element()
 const view=createScreenView({panel,status,text,input,header:{offsetHeight:80},api:async path=>path.endsWith('/approval')?{status:'none'}:{online:false,screen:''}})
 await view.open({id:'a',name:'トロニー',displayName:'トロニー 本番'})
 assert.equal(input.hidden,true);assert.equal(status.textContent,'トロニーは止まっています。次のメッセージで起動します')
})
