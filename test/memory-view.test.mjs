import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryView } from '../web/memory-view.js'
const deferred=()=>{let resolve;const promise=new Promise(a=>{resolve=a});return {promise,resolve}}
const settle=()=>new Promise(resolve=>setImmediate(resolve))
class Element{
 value='';children=[];listeners={}
 addEventListener(name,fn){this.listeners[name]=fn}
 querySelectorAll(){return []}
 replaceChildren(...nodes){this.children=nodes}
 reset(){}
 showModal(){this.open=true}
 close(){this.open=false;this.listeners.close()}
}
const originalDocument=globalThis.document
function fixture(t,api){
 globalThis.document={createElement:()=>new Element()};t.after(()=>{globalThis.document=originalDocument})
 const nodes=new Map(),dialog=new Element()
 const get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id)}
 dialog.querySelector=selector=>get(selector.slice(1))
 const view=createMemoryView(dialog,{api})
 get('remember-kind').value='fact';get('remember-scope').value='personal'
 get('knowledge-scope').value='personal';get('recall-scope').value='personal';get('knowledge-search-scope').value='personal'
 const submit=id=>get(id).listeners.submit({preventDefault(){}})
 return {view,dialog,get,submit}
}
test('memory write snapshots target and body; new text survives and same form stays single flight',async t=>{
 const pending=deferred(),requests=[]
 const f=fixture(t,(path,request)=>{requests.push({path,body:JSON.parse(request.body)});return pending.promise})
 f.view.open({id:'a',displayName:'A'});f.get('remember-content').value='old';f.submit('remember-form');f.submit('remember-form')
 f.get('remember-content').value='new';pending.resolve({});await settle()
 assert.equal(requests.length,1);assert.equal(requests[0].path,'/api/bots/a/memory');assert.equal(requests[0].body.content,'old')
 assert.equal(f.get('remember-content').value,'new');assert.equal(f.get('memory-results').textContent,'記憶しました。')
})
test('old knowledge save cannot clear a newly opened Bot form; unchanged input resets normally',async t=>{
 const a=deferred(),b=deferred(),requests=[]
 const f=fixture(t,(path,request)=>{requests.push(path);return path.includes('/a/')?a.promise:b.promise})
 f.view.open({id:'a',displayName:'A'});f.get('knowledge-title').value='A title';f.get('knowledge-content').value='A';f.submit('knowledge-form')
 f.view.open({id:'b',displayName:'B'});f.get('knowledge-content').value='B';let resets=0;f.get('knowledge-form').reset=()=>{resets++}
 a.resolve({});await settle();assert.equal(resets,0);assert.equal(f.get('knowledge-content').value,'B')
 f.submit('knowledge-form');b.resolve({});await settle();assert.equal(resets,1);assert.deepEqual(requests,['/api/bots/a/knowledge','/api/bots/b/knowledge'])
})
test('search results belong to current Bot and latest query including scope',async t=>{
 const reads=[],paths=[]
 const f=fixture(t,path=>{paths.push(path);const d=deferred();reads.push(d);return d.promise})
 f.view.open({id:'a',displayName:'A'});f.get('recall-query').value='old';f.submit('recall-form')
 f.view.open({id:'b',displayName:'B'});f.get('recall-query').value='new';f.get('recall-scope').value='shared';f.submit('recall-form')
 reads[1].resolve({items:[{kind:'fact',content:'B result'}]});await settle();reads[0].resolve({items:[{kind:'fact',content:'A old'}]});await settle()
 assert.equal(f.get('memory-results').children[0].textContent,'[fact] B result');assert.match(paths[1],/^\/api\/bots\/b\/memory\?query=new&scope=shared$/)
 f.get('recall-query').value='next';f.submit('recall-form');f.get('recall-query').value='latest';f.submit('recall-form')
 reads[3].resolve({items:[{kind:'fact',content:'latest'}]});await settle();reads[2].resolve({items:[{kind:'fact',content:'stale'}]});await settle()
 assert.equal(f.get('memory-results').children[0].textContent,'[fact] latest')
})
