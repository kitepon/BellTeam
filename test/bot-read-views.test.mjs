import test from 'node:test'
import assert from 'node:assert/strict'
import { createScreenView, createCharacterSheetView } from '../web/bot-read-views.js'
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
const settle=()=>new Promise(resolve=>setImmediate(resolve))
class Element {
 children=[];style={};listeners={};hidden=true;scrollHeight=100;scrollTop=0;clientHeight=100;clientWidth=500
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
 platform(t);let timers=0;t.mock.method(globalThis,'setInterval',()=>{timers++;return 1});t.mock.method(globalThis,'clearInterval',()=>{})
 const pending=deferred(),panel=new Element(),status=new Element(),text=new Element()
 const view=createScreenView({panel,status,text,header:{offsetHeight:80},api:()=>pending.promise})
 const opened=view.open({id:'a',displayName:'A'});view.close();pending.resolve({online:true,screen:'old'});await opened
 assert.equal(timers,0);assert.equal(panel.hidden,true);assert.equal(text.textContent,undefined)
})
test('screen reopening owns its result and only creates one current timer',async t=>{
 platform(t);let timers=0;t.mock.method(globalThis,'setInterval',()=>{timers++;return 1});t.mock.method(globalThis,'clearInterval',()=>{})
 const a=deferred(),b=deferred(),panel=new Element(),status=new Element(),text=new Element()
 const view=createScreenView({panel,status,text,header:{offsetHeight:80},api:path=>path.includes('/a/')?a.promise:b.promise})
 const first=view.open({id:'a',displayName:'A'}),second=view.open({id:'b',displayName:'B'})
 b.resolve({online:true,screen:'B screen  '});await second;a.reject(Error('A failure'));await first
 assert.equal(text.textContent,'B screen');assert.match(status.textContent,/B の画面/);assert.equal(timers,1)
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
