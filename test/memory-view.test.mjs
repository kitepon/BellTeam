import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryView, memoryKindLabel } from '../web/memory-view.js'
const deferred=()=>{let resolve;const promise=new Promise(a=>{resolve=a});return {promise,resolve}}
const settle=()=>new Promise(resolve=>setImmediate(resolve))
class Element{
 value='';children=[];listeners={}
 addEventListener(name,fn){this.listeners[name]=fn}
 setAttribute(name,value){this[name]=value}
 focus(){}
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
 f.view.open({id:'a',displayName:'A'});f.get('remember-open').listeners.click();assert.equal(f.get('remember-sheet').hidden,false);f.get('remember-content').value='old';f.submit('remember-form');f.submit('remember-form')
 f.get('remember-content').value='new';pending.resolve({});await settle()
 assert.equal(requests.length,1);assert.equal(requests[0].path,'/api/bots/a/memory');assert.equal(requests[0].body.content,'old')
 assert.equal(f.get('remember-content').value,'new');assert.equal(f.get('remember-result').textContent,'記憶しました。');assert.equal(f.get('remember-sheet').hidden,false,'new text typed meanwhile keeps the form open')
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
 assert.deepEqual(f.get('memory-results').children[0].children.map(n=>n.textContent),['事実','B result']);assert.match(paths[1],/^\/api\/bots\/b\/memory\?query=new&scope=shared$/)
 f.get('recall-query').value='next';f.submit('recall-form');f.get('recall-query').value='latest';f.submit('recall-form')
 reads[3].resolve({items:[{kind:'fact',content:'latest'}]});await settle();reads[2].resolve({items:[{kind:'fact',content:'stale'}]});await settle()
 assert.deepEqual(f.get('memory-results').children[0].children.map(n=>n.textContent),['事実','latest'])
})

test('memory kinds read in Japanese; unknown kinds are その他; the title is the name only',()=>{
 const expected={fact:'事実',preference:'好み',policy:'方針',task:'継続中の仕事',config:'設定',incident:'出来事',relationship:'関係',episode:'思い出',growth:'成長'}
 for(const [kind,label] of Object.entries(expected))assert.equal(memoryKindLabel(kind),label)
 for(const kind of ['mystery','toString','',undefined,null])assert.equal(memoryKindLabel(kind),'その他')
})
test('each action reports next to its own button; tabs switch; titles carry no ids',async t=>{
 const f=fixture(t,path=>{if(path.includes('/knowledge'))throw Object.assign(new Error('KNOWLEDGE_UNAVAILABLE'),{status:503});return Promise.resolve({items:[{kind:'weird',content:'x'}]})})
 f.view.open({id:'bot-1234',displayName:'トロニー'})
 assert.equal(f.get('memory-dialog-title').textContent,'トロニーの記憶と知識')
f.get('memory-tab-knowledge').listeners.click()
 assert.equal(f.get('memory-panel-memory').hidden,true);assert.equal(f.get('memory-panel-knowledge').hidden,false);assert.equal(f.get('memory-tab-knowledge')['aria-selected'],'true')
 f.get('knowledge-query').value='q';f.submit('knowledge-search-form');await settle()
 assert.match(f.get('knowledge-search-result').textContent,/検索できませんでした/);assert.equal(f.get('knowledge-search-submit').textContent,'検索')
 assert.doesNotMatch(f.get('knowledge-search-result').textContent,/KNOWLEDGE_UNAVAILABLE|503/)
 assert.equal(f.get('recall-result').textContent,'');assert.equal(f.get('remember-error').textContent,'')
 f.get('memory-tab-memory').listeners.click();f.get('recall-query').value='x';f.submit('recall-form');await settle()
 assert.equal(f.get('memory-results').children[0].children[0].textContent,'その他')
 f.get('knowledge-title').value='t';f.get('knowledge-content').value='c';f.submit('knowledge-form');await settle()
 assert.match(f.get('knowledge-error').textContent,/保存できませんでした/);assert.equal(f.get('knowledge-result').textContent,'')
})
