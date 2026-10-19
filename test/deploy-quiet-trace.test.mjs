import test from 'node:test'
import assert from 'node:assert/strict'
import * as api from '../scripts/check-deploy-quiet.mjs'

const node='/usr/local/bin/node'
const root={pid:10,ppid:1,pgid:10,start:'100',state:'S',exe:'/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',argv:null,cwd:'/srv/bellteam/bots/bot-peer'}
const hook={pid:20,ppid:10,pgid:10,start:'110',state:'S',exe:node,argv:[node,'/home/bell/.approval-box/runtime/0.1.26/approval-box-claude-hook.mjs']}
const seat={botId:'bot-peer',name:'待機担当',session:'peer',candidates:[root,hook].map(({pid,ppid,start,exe})=>({pid,ppid,start,exe}))}
const idle={exists:true,state:'idle',reason:'composer_ready',pending_child_deliveries:0,launch_id:'fixture-launch',harness:'claude-code',harness_process:{pid:10,process_group_id:10,started_identity:'fixture-start',argv_digest:'a'.repeat(64)}}
const secret='private-error-argv-or-profile-canary'
async function run(config={},traced=true){
 const calls=[],events=[];let tables=0,trees=0,observations=0
 const deps={readTable:async()=>{calls.push('table');if(++tables===config.tableFail)throw Object.assign(Error(secret),{code:'ENOENT',path:'/proc/999/stat'});return new Map([root,hook].map(r=>[r.pid,r]))},
 readTree:async()=>{calls.push('tree');if(++trees===config.treeFail)throw Object.assign(Error(secret),{code:'ENOENT',path:'/proc/999/exe'});return structuredClone(config.hookChange&&trees>1?[root,{...hook,pid:21,start:'120'}]:config.untrusted?[root,hook,{pid:30,ppid:10,pgid:10,start:'120',state:'S',exe:node,argv:[node,secret]}]:[root,hook])},
 readStart:async()=>{calls.push('start');return config.start??'fixture-start'}}
 const transport={seatTurns:async()=>null,observe:async()=>{calls.push('observe');return structuredClone(config.observations?.[observations++]??idle)}}
 const chosen=config.seat??seat
 const confirmIdle=traced?api.createTracedConfirm(api,e=>events.push(e),deps):(t,s,o)=>api.confirmDeployIdle(t,s,{...o,...deps})
 const result=await api.collectDeployTurns(transport,[chosen],{confirmIdle,trace:traced?e=>events.push(e):undefined})
 assert.doesNotMatch(JSON.stringify(events),new RegExp(secret+'|fixture-start|fixture-launch|'+ 'a'.repeat(64)+'|/proc/999'))
 for(const event of events)for(const key of Object.keys(event))assert.ok(!['pid','start','argv','environ','path','message','digest','started_identity','session'].includes(key))
 return {value:result.get(chosen.session),calls,events}
}

for(const [name,config,expected]of[
 ['idle',{},'idle'],['first table missing',{tableFail:1},null],['second table missing',{tableFail:2},null],['last table missing',{tableFail:3},null],
 ['first exe missing',{treeFail:1},null],['second exe missing',{treeFail:2},null],['last exe missing',{treeFail:3},null],
 ['hook changed',{hookChange:true},null],['unknown descendant',{untrusted:true},null],['wrong start',{start:secret},null],
 ['busy first',{observations:[{...idle,state:'busy'}]},'running'],['busy second',{observations:[idle,{...idle,state:'busy'}]},'running'],
 ['pending delivery',{observations:[{...idle,pending_child_deliveries:1}]},null],
 ['other root',{seat:{...seat,candidates:[...seat.candidates,{...seat.candidates[0],pid:99}]}},null],
])test('trace preserves decision and complete read sequence: '+name,async()=>{
 const traced=await run(config),plain=await run(config,false)
 assert.deepEqual(traced.value,plain.value);assert.deepEqual(traced.calls,plain.calls);assert.equal(traced.value?.state??null,expected)
 if(name.includes('table missing'))assert.ok(traced.events.some(e=>e.reason==='table_stat_missing'))
 if(name.includes('exe missing'))assert.ok(traced.events.some(e=>e.reason==='tree_exe_missing'))
 if(name==='hook changed')assert.ok(traced.events.some(e=>e.reason==='hook_changed'))
 if(expected==='running')assert.ok(traced.events.some(e=>e.reason==='actual_turn'&&e.name==='待機担当'))
 if(name==='idle')assert.deepEqual(traced.calls,['table','observe','start','tree','table','tree','observe','table','tree'])
})

test('known running turn includes seat name without confirm/observe reads',async()=>{
 const events=[];const result=await api.collectDeployTurns({seatTurns:async()=>new Map([['peer',{state:'running'}]])},[seat],
 {trace:e=>events.push(e),confirmIdle:()=>assert.fail('known running needs no confirmation')})
 assert.equal(result.get('peer').state,'running');assert.equal(events[0].reason,'actual_turn');assert.equal(events[0].name,seat.name)
})

test('candidate change and both queues are traced without adding callbacks or emitting queue body',async()=>{
 async function fixture(trace){
  const calls=[],events=[];let reads=0
  const result=await api.checkDeployQuiet({except:'bot-self',trace:trace?e=>events.push(e):undefined,
   fetchQueue:async()=>{calls.push('queue');return[{botId:seat.botId,botName:seat.name,message:secret}]},
   readSeats:async()=>{calls.push('seats');return{unknown:0,seats:[{...seat,candidates:++reads===1?seat.candidates:[]}]}},
   readSeatTurns:async()=>{calls.push('turns');return new Map([['peer',{state:'idle'}]])}})
  return{result,calls,events}
 }
 const traced=await fixture(true),plain=await fixture(false)
 assert.deepEqual(traced.result,plain.result);assert.deepEqual(traced.calls,plain.calls)
 assert.deepEqual(traced.calls,['queue','seats','turns','seats','queue'])
 assert.equal(traced.result.quiet,false);assert.ok(traced.events.some(e=>e.reason==='candidate_changed'))
 assert.deepEqual(traced.events.filter(e=>e.reason==='queue').map(e=>e.stage),['BEFORE','AFTER'])
 assert.doesNotMatch(JSON.stringify(traced.events),new RegExp(secret))
})

test('trace sink exceptions cannot change idle confirmation',async()=>{
 const value=await api.createTracedConfirm(api,()=>{throw Error(secret)},
 {readTable:async()=>new Map([root,hook].map(r=>[r.pid,r])),readTree:async()=>structuredClone([root,hook]),readStart:async()=>'fixture-start'})({observe:async()=>idle},seat)
 assert.deepEqual(value,{state:'idle'})
})
