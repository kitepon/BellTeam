import test from 'node:test'
import assert from 'node:assert/strict'
import { createNotificationNavigation } from '../web/notification-navigation.js'
import { deferred } from './helpers/editor-dom.mjs'
const route={kind:'owner_question',messageId:'question',requestId:'question',botId:'bot-a',roomId:null}
function fixture(url='https://example.com/') {
 const data=new Map(),handlers={},routed=[],notices=[]
 const browser={location:{href:url,origin:'https://example.com'},history:{replaceState(a,b,url){browser.location.href=url}},sessionStorage:{getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)},navigator:{serviceWorker:{addEventListener:(k,fn)=>{handlers[k]=fn},removeEventListener:(k)=>{delete handlers[k]}}}}
 const nav=createNotificationNavigation({browser,onRoute:async value=>routed.push(value),onNotice:notice=>notices.push(notice)})
 return{browser,data,handlers,routed,notices,nav}
}
test('a cold notification click waits for normal auth/setup readiness, then consumes only the valid ID route',async()=>{
 const f=fixture('https://example.com/?notification='+encodeURIComponent(JSON.stringify(route)))
 assert.equal(f.routed.length,0);assert.equal(f.data.size,1)
 await f.nav.ready();assert.deepEqual(f.routed,[route]);assert.equal(f.data.size,0)
 assert.equal(new URL(f.browser.location.href).searchParams.has('notification'),false)
})
test('foreign messages and invalid route fields cannot trigger target navigation',async()=>{
 const f=fixture();await f.nav.ready()
 f.handlers.message({origin:'https://evil.example',data:{type:'bellteam-notification',route}})
 f.handlers.message({origin:'https://example.com',data:{type:'bellteam-notification',route:{...route,url:'https://evil.example'}}})
 assert.equal(f.routed.length,0);assert.match(f.notices.at(-1),/一覧から/)
})
test('a failed route retains only IDs for explicit retry, without retry loops or secret/url state',async()=>{
 const f=fixture();let tries=0
 const nav=createNotificationNavigation({browser:f.browser,onRoute:async()=>{if(++tries===1)throw Error('offline')},onNotice:n=>f.notices.push(n)})
 await nav.ready();f.handlers.message({origin:'https://example.com',data:{type:'bellteam-notification',route}})
 await new Promise(r=>setImmediate(r));assert.equal(tries,1);assert.equal(f.data.size,1)
 await nav.retry();assert.equal(tries,2);assert.equal(f.data.size,0)
})

test('invalid cold-link input clears a previously held route rather than opening an unrelated old target',async()=>{
 const f=fixture();f.data.set('bellteam-notification-route.v1',JSON.stringify(route));f.browser.location.href='https://example.com/?notification=not-json'
 const nav=createNotificationNavigation({browser:f.browser,onRoute:async v=>f.routed.push(v),onNotice:n=>f.notices.push(n)})
 await nav.ready();assert.equal(f.routed.length,0);assert.equal(f.data.size,0);assert.match(f.notices.at(-1),/一覧から/)
})
