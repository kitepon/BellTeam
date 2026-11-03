import test from 'node:test'
import assert from 'node:assert/strict'
import { parseNotificationPayload, notificationPresentation, notificationRoute, notificationURL } from '../web/notification-payload.js'
import { installNotificationWorker } from '../web/notification-worker.js'
const event=(kind='reply',room=false)=>({schema:'bellteam.web-push.v1',kind,messageId:'event-id',requestId:kind==='reply'?null:'event-id',botId:'bot-a',roomId:room?'room-a':null,sender:{id:'bot-a',name:'アドミ'},roomName:room&&kind==='reply'?'開発室':null,title:room&&kind==='reply'?'アドミ · 開発室':'アドミ',body:kind==='secret_request'?'秘密情報の入力が必要です。':kind==='owner_question'?'選んでほしいことがあります。':room?'ルームに新しいメッセージが届きました。':'返信が届きました。'})
test('strict four notification variants preserve IDs and use fixed public text only',()=>{
 for(const value of [event(),event('reply',true),event('secret_request',true),event('owner_question')]){
  const parsed=parseNotificationPayload(JSON.stringify(value));assert(parsed)
  assert.equal(notificationPresentation(parsed).body,value.body)
  assert.equal(notificationRoute(parsed.route).messageId,'event-id')
  const url=new URL(notificationURL(parsed.route,'https://example.com'))
  assert.equal(url.origin,'https://example.com');assert.equal(url.pathname,'/')
 }
})
test('extra keys, arbitrary content/URLs, broken ID relations, control and byte overflows become generic notices',()=>{
 const value=event()
 const invalid=[{...value,url:'https://evil.example/'},{...value,body:'private conversation'},{...value,title:'untrusted title'}, {...value,sender:{id:'other',name:'アドミ'}}, {...value,requestId:'injected'}, {...value,kind:'owner_question',requestId:'different'}, {...value,botId:'x\n'}, {...value,messageId:'猫'.repeat(67)}, {...value,roomName:'unexpected'}, {...event('owner_question'),roomId:'room-a'}, {...value,sender:{id:'bot-a',name:'x'.repeat(4000)}}]
 for(const input of invalid){const result=parseNotificationPayload(JSON.stringify(input));assert.equal(result,null);assert.equal(notificationPresentation(result).route,null)}
 assert.equal(parseNotificationPayload('not JSON'),null)
 assert.equal(notificationRoute({...parseNotificationPayload(JSON.stringify(value)).route,url:'https://evil'}),null)
})
function worker(){
 const handlers={},shown=[],opened=[],messages=[]
 const scope={location:{origin:'https://example.com'},addEventListener:(name,fn)=>{handlers[name]=fn},skipWaiting:async()=>{},registration:{async showNotification(title,options){shown.push({title,options})}},clients:{async claim(){},async matchAll(){return[]},async openWindow(url){opened.push(url)}}}
 installNotificationWorker(scope)
 return{scope,handlers,shown,opened,messages,async dispatch(name,value){let pending;handlers[name]({...value,waitUntil(p){pending=p}});await pending}}
}
test('SW always shows a visible notification and routes invalid payloads only to same-origin root',async()=>{
 const f=worker()
 await f.dispatch('push',{data:{text:()=>JSON.stringify({...event(),endpoint:'secret endpoint'})}})
 assert.deepEqual(f.shown[0].options.data,null);assert.equal(f.shown[0].title,'BellTeam')
 let closed=0
 await f.dispatch('notificationclick',{notification:{data:{url:'https://evil.example'},close(){closed++}}})
 assert.equal(closed,1);assert.deepEqual(f.opened,['https://example.com/'])
})
test('valid clicks focus only a same-origin app client and pass closed ID data without navigating to arbitrary URL',async()=>{
 const f=worker(),route=parseNotificationPayload(JSON.stringify(event('secret_request',true))).route
 let focused=0
 f.scope.clients.matchAll=async()=>[{url:'https://evil.example/',focus(){throw Error('foreign')}},{url:'https://example.com/',async focus(){focused++},postMessage(value){f.messages.push(value)}}]
 await f.dispatch('notificationclick',{notification:{data:route,close(){}}})
 assert.equal(focused,1);assert.equal(f.opened.length,0)
 assert.deepEqual(f.messages,[{type:'bellteam-notification',route}])
})

test('supplier 2d8b4b1a four public payload fixtures match SW validation and fixed presentation',async()=>{
 const {readFile}=await import('node:fs/promises')
 const values=JSON.parse(await readFile(new URL('fixtures/web-push-public.json',import.meta.url),'utf8'))
 assert.equal(values.syntheticOnly,true);assert.equal(values.doNotSend,true)
 for(const payload of values.payloads)assert(parseNotificationPayload(JSON.stringify(payload)))
})
