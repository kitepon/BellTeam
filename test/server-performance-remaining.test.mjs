import assert from 'node:assert/strict'
import { once } from 'node:events'
import { appendFile, mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import nodeTest from 'node:test'
const test = (name, fn) => nodeTest(name, {timeout: 3000}, fn)
const repo = process.env.TEST_REPO ?? fileURLToPath(new URL('../', import.meta.url))
const load = path => import(pathToFileURL(join(repo, path)))
const { ConversationStore } = await load('src/conversation-store.mjs')
const { RoomRegistry } = await load('src/room-registry.mjs')
const { SecretRequests } = await load('src/secret-requests.mjs')
const { OwnerQuestions } = await load('src/owner-questions.mjs')
const { AitermTransport } = await load('src/aiterm-transport.mjs')
const { BotRegistry } = await load('src/bot-registry.mjs')
const { createBellTeamServer, pageItems } = await load('src/http-server.mjs')
const line = x => JSON.stringify(x) + '\n'
const direct = (id, extra = {}) => ({ schema:'bellteam.direct-message.v1', delivery_id:id, from:'user', target:'bot-a', message:id, at:'2026-10-22T00:00:00Z', delivery:'running', ...extra })
async function temp(t) {
 const root = await mkdtemp(join(tmpdir(),'bell-performance-remaining-'))
 t.after(() => rm(root,{recursive:true,force:true})); return root
}
async function http(t, options) {
 const server = createBellTeamServer({authorize:()=>true,writeLog(){},...options})
 server.listen(0,'127.0.0.1');await once(server,'listening')
 t.after(()=>{server.closeAllConnections();server.close()})
 const base=`http://127.0.0.1:${server.address().port}`
 return {server,base,get:async path=>{const response=await fetch(base+path);assert.equal(response.status,200);return response.json()}}
}
async function events(t, server, base) {
 await server.startMessageWatch()
 const abort=new AbortController();t.after(()=>abort.abort())
 const deadline=setTimeout(()=>abort.abort(new Error('SSE_EVENT_NOT_RECEIVED')),1000);t.after(()=>clearTimeout(deadline))
 const response=await fetch(base+'/api/events',{signal:abort.signal}), reader=response.body.getReader()
 let buffer=''
 const next=async()=>{while(!buffer.includes('\n\n')){const {value,done}=await reader.read();if(done)throw Error('SSE_ENDED');buffer+=new TextDecoder().decode(value)}const end=buffer.indexOf('\n\n');const raw=buffer.slice(0,end);buffer=buffer.slice(end+2);return raw}
 assert.equal(await next(),'event: ready\ndata: {}')
 return async()=>{let raw;do{raw=await next()}while(!raw.startsWith('event: messages'));return JSON.parse(raw.slice(raw.indexOf('data: ')+6))}
}

test('overlapping screen/list requests share one pty_list; later requests are fresh',async()=>{
 let count=0,finish
 const pending=new Promise(r=>finish=r)
 const transport=new AitermTransport({client:{async call(name){if(name==='pty_list'){count++;await pending;return {content:[{type:'text',text:'bot-a\tx'}]}}if(name==='pty_read')return {content:[{type:'text',text:'screen'}]};throw Error(name)}}})
 const bot={id:'bot-a',session:'bot-a'}
 const reads=[transport.screen(bot),...Array.from({length:20},()=>transport.runningBots([bot]))]
 await new Promise(r=>setImmediate(r));assert.equal(count,1);finish();await Promise.all(reads)
 await transport.runningBots([bot]);assert.equal(count,2)
})

test('a past delivery update does not rematerialize every unchanged history row',async t=>{
 const root=await temp(t),path=join(root,'direct.jsonl')
 await writeFile(path,Array.from({length:3000},(_,i)=>line(direct('m'+i))).join(''))
 const original=JSON.parse;let reads=0
 JSON.parse=(...args)=>{const row=original(...args);return row?.schema==='bellteam.direct-message.v1'?new Proxy(row,{get(target,key){if(key==='message')reads++;return target[key]}}):row}
 try{
  const store=new ConversationStore({logPath:path})
  const {get}=await http(t,{bots:new Map([['bot-a',{id:'bot-a'}]]),store})
  const old=await get('/api/bots/bot-a/messages?limit=10')
  reads=0;await appendFile(path,line({schema:'bellteam.delivery-status.v1',delivery_id:'m0',delivery:'failed'}))
  const current=await get('/api/bots/bot-a/messages?after=m0&limit=1')
  assert.equal(current.items.length,2999);assert.equal(current.has_more,false)
  assert.ok(reads<10,`unchanged raw rows projected: ${reads}`)
  assert.equal(old.items[0].delivery,'running')
 }finally{JSON.parse=original}
})

test('cards are indexed by target and old responses survive answers and names',async t=>{
 const root=await temp(t), bots=new Map([['bot-a',{id:'bot-a',name:'A'}],['bot-b',{id:'bot-b',name:'B'}]])
 const questions=new OwnerQuestions({root,bots,notify:async()=>{}});await questions.initialize()
 const a=await questions.create({botId:'bot-a',question:'a?',options:['a','b']})
 await questions.create({botId:'bot-b',question:'b?',options:['a','b']})
 const old=questions.timeline({botId:'bot-a'})
 questions.items.values=()=>{throw Error('full collection scan')}
 assert.equal(questions.timeline({botId:'bot-a'})[0].id,a.id)
 await questions.answer(a.id,{choice:'a'})
 assert.equal(questions.timeline({botId:'bot-a'})[0].owner_question.status,'answered')
 assert.equal(old[0].owner_question.status,'open')
 bots.set('bot-a',{id:'bot-a',name:'renamed'})
 assert.equal(questions.timeline({botId:'bot-a'})[0].sender.name,'renamed')
 const requests=new SecretRequests({root,bots,rooms:new Map(),notify:async()=>{}});await requests.initialize()
 const request=await requests.create({botId:'bot-a',toolId:'test',label:'l',message:'m'})
 requests.items.values=()=>{throw Error('full collection scan')}
 const first=requests.timeline({botId:'bot-a'})
 await requests.cancel(request.id)
 assert.equal(requests.timeline({botId:'bot-a'})[0].secret_request.status,'cancelled')
 assert.equal(first[0].secret_request.status,'pending')
})

test('room metadata skips unchanged content reads but detects same-size edit/replacement/deletion',async t=>{
 const root=await temp(t),rooms=new RoomRegistry({roomsRoot:root,bots:new Map(),roomId:()=> 'room-a'})
 await rooms.initialize();await rooms.create({name:'one',memberIds:[]})
 const original=rooms.read.bind(rooms);let reads=0;rooms.read=async id=>{reads++;return original(id)}
 await rooms.refresh();await rooms.refresh();assert.equal(reads,0)
 const path=join(root,'room-a','room.json')
 const definition=name=>line({schema:'bellteam.room.v1',id:'room-a',name,memberIds:[]})
 await writeFile(path,definition('two'));await rooms.refresh();assert.equal(rooms.get('room-a').name,'two');assert.equal(reads,1)
 await writeFile(path+'.new',definition('new'));await rename(path+'.new',path);await rooms.refresh();assert.equal(rooms.get('room-a').name,'new')
 await writeFile(path,'{broken}');await assert.rejects(rooms.refresh(),SyntaxError);assert.equal(rooms.get('room-a').name,'new')
 await rm(path);await rooms.refresh();assert.equal(rooms.has('room-a'),false)
})

test('SSE unions all targets/topics and unknown changes dominate; immediate type remains',async t=>{
 let change
 const {server,base}=await http(t,{bots:new Map(),store:{watch(fn){change=fn;return ()=>{}},timeline:async()=>[]},messageEventWindow:5})
 const next=await events(t,server,base)
 change({all:false,topics:['timeline'],botIds:['bot-a','bot-b'],roomIds:[]})
 change({all:false,topics:['queue','schedules'],botIds:['bot-c'],roomIds:['room-a']})
 const merged=await next();assert.equal(merged.all,false);assert.deepEqual(new Set(merged.botIds),new Set(['bot-a','bot-b','bot-c']));assert.deepEqual(new Set(merged.topics),new Set(['timeline','queue','schedules']));assert.ok(merged.at)
 change({all:false,topics:['timeline'],botIds:['bot-a'],roomIds:[]});change()
 assert.equal((await next()).all,true)
 server.notify({type:'settings',featureId:'test'})
 const immediate=await next();assert.equal(immediate.type,'settings');assert.equal(immediate.featureId,'test');assert.equal(immediate.all,true)
})

test('real direct watch targets both peer histories and becomes global after replacement',async t=>{
 const root=await temp(t),path=join(root,'direct.jsonl');await writeFile(path,line(direct('old')))
 const store=new ConversationStore({logPath:path});await store.timeline('bot-a')
 const {server,base}=await http(t,{bots:new Map(),store,messageEventWindow:5})
 const next=await events(t,server,base)
 await appendFile(path,line(direct('peer',{from:'bot-a',target:'bot-b'})))
 let item=await next();assert.equal(item.all,false);assert.deepEqual(new Set(item.botIds),new Set(['bot-a','bot-b']))
 await appendFile(path,line({schema:'bellteam.delivery-status.v1',delivery_id:'peer',delivery:'failed'}))
 item=await next();assert.equal(item.all,false);assert.deepEqual(new Set(item.botIds),new Set(['bot-a','bot-b']))
 await writeFile(path+'.new',line(direct('new')));await rename(path+'.new',path)
 assert.equal((await next()).all,true)
})

test('room schedule changes from external files produce a schedules target',async t=>{
 const root=await temp(t),rooms=new RoomRegistry({roomsRoot:root,bots:new Map(),roomId:()=> 'room-a'})
 await rooms.initialize();await rooms.create({name:'room',memberIds:[]})
 const {server,base}=await http(t,{rooms,bots:new Map(),store:{watch:async()=>()=>{},timeline:async()=>[]},messageEventWindow:5})
 const next=await events(t,server,base)
 await writeFile(join(root,'room-a','schedule.json'),line({schema:'bellteam.schedule.v1',schedules:[]}))
 const change=await next();assert.equal(change.all,false);assert.deepEqual(change.topics,['schedules']);assert.deepEqual(change.roomIds,['room-a'])
})

test('indexed merge agrees with legacy stable sort/page for duplicate IDs and equal/out-of-order timestamps',async t=>{
 const root=await temp(t),path=join(root,'direct.jsonl')
 await writeFile(path,[direct('same',{at:'c'}),direct('first',{at:'a'}),direct('same',{at:'b'}),direct('end',{at:'c'})].map(line).join(''))
 const bots=new Map([['bot-a',{id:'bot-a',name:'A'}]])
 const questions=new OwnerQuestions({root,bots,notify:async()=>{},now:()=> 'b',id:()=> 'card'});await questions.initialize();await questions.create({botId:'bot-a',question:'q',options:['a','b']})
 const store=new ConversationStore({logPath:path});const rows=[...await store.timeline('bot-a'),...questions.timeline({botId:'bot-a'})].sort((a,b)=>(a.at??'').localeCompare(b.at??''))
 const {get}=await http(t,{bots,store,ownerQuestions:questions})
 for(const query of ['limit=1','before=same&limit=2','after=same&limit=1','before=missing&limit=3','after=missing&limit=1','after=card&before=first&limit=2']){
  const expected=pageItems(rows,new URL('http://x/?'+query)),actual=await get('/api/bots/bot-a/messages?'+query)
  assert.deepEqual(actual.items.map(x=>x.id),expected.items.map(x=>x.id),query);assert.equal(actual.has_more,expected.has_more,query)
 }
})


test('session mutation invalidates a shared list across dispatch and completion',async()=>{
 let lists=0,release
 const held=new Promise(r=>release=r)
 const bot={id:'bot-a',session:'bot-a'}
 const transport=new AitermTransport({client:{async call(name){if(name==='pty_list'){lists++;if(lists===1)await held;return {content:[{type:'text',text:''}]}}return {}}}})
 const first=transport.runningBots([bot]);await new Promise(r=>setImmediate(r))
 await transport.changeSession(bot,'pty_close',{session_id:'bot-a'})
 await transport.runningBots([bot]);assert.equal(lists,2)
 release();await first
 await transport.runningBots([bot]);assert.equal(lists,3)
})

test('known Bot schedule writes include schedules and the Bot destination',async t=>{
 const root=await temp(t);await mkdir(join(root,'bot-a'))
 const registry=new BotRegistry({botsRoot:root,seedPath:join(root,'seed.json')});let changed
 registry.watch(value=>changed=value)
 await registry.writeScheduleDocument('bot-a',[])
 assert.equal(changed?.all,false);assert.deepEqual(changed.topics,['schedules']);assert.deepEqual(changed.botIds,['bot-a'])
})

test('invalid direct batches never partly update visible rows; unknown status targets stay global',async t=>{
 const root=await temp(t),path=join(root,'direct.jsonl')
 await writeFile(path,line(direct('a')))
 const store=new ConversationStore({logPath:path});const before=await store.timeline('bot-a')
 await appendFile(path,line({schema:'bellteam.delivery-status.v1',delivery_id:'a',delivery:'failed'})+'{broken}\n')
 for(let i=0;i<2;i++)await assert.rejects(store.timeline('bot-a'),/MESSAGE_LOG_INVALID: line 3/)
 assert.equal(before[0].delivery,'running')
 await writeFile(path,line(direct('a')))
 await store.timeline('bot-a')
 const {server,base}=await http(t,{bots:new Map(),store,messageEventWindow:5});const next=await events(t,server,base)
 await appendFile(path,line({schema:'bellteam.delivery-status.v1',delivery_id:'unknown',delivery:'failed'}))
 assert.equal((await next()).all,true)
})


test('room append is targeted but same-size replacement/truncation requires global reconciliation',async t=>{
 const root=await temp(t),rooms=new RoomRegistry({roomsRoot:root,bots:new Map(),roomId:()=> 'room-a'})
 await rooms.initialize();await rooms.create({name:'room',memberIds:[]})
 await rooms.appendMessage('room-a',{id:'old',message:'x'})
 const {server,base}=await http(t,{rooms,bots:new Map(),store:{watch:async()=>()=>{},timeline:async()=>[]},messageEventWindow:5})
 const next=await events(t,server,base)
 await rooms.appendMessage('room-a',{id:'new',message:'x'})
 let change=await next();assert.equal(change.all,false);assert.deepEqual(change.roomIds,['room-a'])
 await writeFile(join(root,'room-a','messages.jsonl'),line({id:'alt',message:'x'}))
 assert.equal((await next()).all,true)
})

test('reading an empty log repeatedly does not feed a self-triggered SSE loop',async t=>{
 const root=await temp(t),path=join(root,'direct.jsonl');await writeFile(path,'')
 const store=new ConversationStore({logPath:path});let changes=0
 const stop=await store.watch(()=>changes++);t.after(stop)
 await store.timeline('bot-a');const initial=changes
 for(let i=0;i<10;i++)assert.deepEqual(await store.timeline('bot-a'),[])
 assert.equal(changes,initial)
})

test('indexed stable merges/pages match the reference across generated inserts/status changes',async()=>{
 const {TimelineIndex,timelinePage,fullTimeline,recentTimeline}=await load('src/timeline-index.mjs')
 let seed=61291
 const random=n=>{seed=(seed*1664525+1013904223)>>>0;return seed%n}
 for(let fixture=0;fixture<30;fixture++){
  const rows=Array.from({length:3},()=>Array.from({length:25},()=>({id:'id'+random(20),at:String(random(10)),status:'old'})))
  const keys=rows.map(group=>group.map(()=>Symbol()))
  const sources=rows.map((group,n)=>new TimelineIndex(group,keys[n]))
  const before=fullTimeline(sources)
  for(let step=0;step<8;step++){
   const group=random(3),index=random(rows[group].length)
   rows[group][index]={...rows[group][index],at:String(random(10)),status:'step'+step}
   sources[group].set(keys[group][index],rows[group][index])
   const appended={id:'id'+random(20),at:String(random(10)),status:'new'}
   rows[group].push(appended);const key=Symbol();keys[group].push(key);sources[group].set(key,appended)
   const reference=rows.flat().sort((a,b)=>a.at.localeCompare(b.at))
   assert.deepEqual(fullTimeline(sources),reference)
   assert.deepEqual(recentTimeline(sources),reference.at(-1))
   for(const query of ['limit=10','before=id'+random(20)+'&limit=4','after=id'+random(20)+'&limit=1','before=unknown&limit=3','after=unknown&limit=2']){
    const url=new URL('http://fixture/?'+query)
    assert.deepEqual(timelinePage(sources,url),pageItems(reference,url),query)
   }
  }
  assert.ok(before.every(row=>row.status==='old'))
 }
})
