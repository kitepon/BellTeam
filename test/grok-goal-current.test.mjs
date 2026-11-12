import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { once } from 'node:events'
import { AitermClient } from '../src/aiterm-client.mjs'
import { BotGoals } from '../src/bot-goals.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'

const read = name => JSON.parse(readFileSync(new URL(`./fixtures/grok-goal-${name}-native.json`, import.meta.url)))
function fixture(initial) {
  let result=structuredClone(initial), calls=0
  const client=new AitermClient()
  client.client={async callTool({name}){assert.equal(name,'agent_goal');calls++;return {isError:result.availability!=='available',structuredContent:result,content:[]}}}
  const bot={id:'bot-grok',session:result.session_id,harness:'grok'}
  const reports=[]
  const transport={session:()=>bot.session,observe:async()=>({schema:'aiterm.pty-observe-result.v1',session_id:bot.session,exists:true,launch_id:result.launch_id}),client}
  const goals=new BotGoals({transport,reportError:async e=>reports.push(e)})
  return {bot,transport,goals,reports,calls:()=>calls,set:r=>{result=structuredClone(r)}}
}
async function http(t,f){
  const server=createBellTeamServer({bots:new Map([[f.bot.id,f.bot]]),rooms:new Map(),store:{},transport:f.transport,goals:f.goals,authorize:async()=>true,writeLog(){}})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}))
  return ()=>fetch(`http://127.0.0.1:${server.address().port}/api/bots/${f.bot.id}/goal`)
}

test('Grokの固定Native V2結果をHTTPへ保ち、保存phaseから現在状態を補わない',async t=>{
  const source=read('paused');source.goal.native.status='active';source.goal.native.phase='Executing'
  source.goal.native.tokens_used_high_water=99999;source.goal.native.elapsed_ms=999999
  const f=fixture(source),get=await http(t,f),response=await get()
  assert.equal(response.status,200)
  const {snapshot}=await response.json()
  assert.equal(snapshot.availability,'available');assert.deepEqual(snapshot.goal,source.goal)
  assert.equal(snapshot.goal.current_status.status,'UserPaused');assert.equal(snapshot.goal.current_status.phase,'Idle')
  assert.deepEqual(snapshot.capabilities,source.capabilities)
  assert.deepEqual(snapshot.fieldCapabilities,{create:{objective:false,tokenBudget:false,combined:false},edit:{objective:false,tokenBudget:false,combined:false}})
  assert.equal(f.calls(),1);assert.deepEqual(f.reports,[])
})

test('Grokのbusy typed拒否は現在goalを省略し、保存済みgoalやnullへ戻さない',async t=>{
  const f=fixture(read('paused')),get=await http(t,f)
  await get();f.set(read('busy'))
  const response=await get(),{snapshot}=await response.json()
  assert.equal(response.status,200);assert.equal(snapshot.availability,'unavailable')
  assert.equal('goal' in snapshot,false);assert.equal(snapshot.binding,null)
  assert.equal(Object.values(snapshot.capabilities).some(Boolean),false)
  assert.equal(f.calls(),2);assert.deepEqual(f.reports,[])
})

test('Grok current_status欠測や型不正を保存snapshotだけの成功にしない',async()=>{
  const cases=[r=>r.goal.current_status.source='file',
    r=>r.goal.current_status.status='unknown',r=>r.goal.current_status.phase='unknown',
    r=>r.goal.current_status.tokens_used=null,r=>r.goal.current_status.elapsed_display='unknown',
    r=>r.goal.native.token_budget=0,r=>r.goal.native.extra='unexpected',r=>r.harness='claude-code']
  for(const change of cases){const source=read('paused');change(source);const f=fixture(source),s=await f.goals.inspect(f.bot)
    assert.equal(s.availability,'unavailable');assert.equal('goal' in s,false)
    assert.equal(f.reports.length,1);assert.equal(f.calls(),1)}
})

test('Grok実行中detailのnullと原文をHTTPに保持し、保存会計を補完しない',async t=>{
  const source=read('detail');source.goal.native.phase='Idle'
  source.goal.native.tokens_used_high_water=4906;source.goal.native.elapsed_ms=999999
  const f=fixture(source),get=await http(t,f),response=await get(),{snapshot}=await response.json()
  assert.equal(response.status,200);assert.equal(snapshot.availability,'available')
  assert.deepEqual(snapshot.goal,source.goal)
  assert.equal(snapshot.goal.current_status.phase,null);assert.equal(snapshot.goal.current_status.tokens_used,null)
  assert.equal(snapshot.goal.current_status.budget_display,'4.9k / 1 tokens (100%)')
  assert.deepEqual(snapshot.capabilities,source.capabilities);assert.equal(f.calls(),1);assert.deepEqual(f.reports,[])
  const paused=read('detail');paused.goal.current_status.status='Paused';paused.goal.current_status.phase_display=null
  f.set(paused);const next=await (await get()).json()
  assert.equal(next.snapshot.availability,'available');assert.equal(next.snapshot.goal.current_status.phase_display,null)
  assert.equal(next.snapshot.capabilities.resume,false)
})

test('Grok detail型の混在・欠測を保存snapshot成功へ補わない',async()=>{
  const cases=[r=>r.goal.current_status.phase='Planning',r=>r.goal.current_status.tokens_used=4906,
    r=>delete r.goal.current_status.phase_display,r=>r.goal.current_status.phase_display='',
    r=>r.goal.current_status.status='UserPaused',r=>r.goal.current_status.status_display='',
    r=>r.goal.current_status.status_display='x'.repeat(129),r=>r.goal.current_status.phase_display='x'.repeat(65),
    r=>r.goal.current_status.budget_display='',r=>r.goal.current_status.budget_display='x'.repeat(129),
    r=>r.goal.current_status.extra='unexpected',r=>r.goal.current_status.source='/goal status',
    r=>r.goal.current_status.elapsed_display='unknown']
  for(const change of cases){const source=read('detail');change(source);const f=fixture(source),s=await f.goals.inspect(f.bot)
    assert.equal(s.availability,'unavailable');assert.equal('goal' in s,false)
    assert.equal(f.reports.length,1);assert.equal(f.calls(),1)}
})

test('a08: current_statusの無いGrok結果は保存状態をgoal detail形の公開current_statusで返す',async t=>{
  const source=read('paused');delete source.goal.current_status
  source.goal.native.status='user_paused';source.goal.native.tokens_used_high_water=4906;source.goal.native.token_budget=100000
  source.goal.native.elapsed_ms=3725000;source.capabilities.resume=true
  const f=fixture(source),get=await http(t,f),response=await get(),{snapshot}=await response.json()
  assert.equal(response.status,200);assert.equal(snapshot.availability,'available');assert.deepEqual(f.reports,[])
  assert.deepEqual(snapshot.goal.native,source.goal.native)
  assert.deepEqual(snapshot.goal.current_status,{source:'goal detail',status:'Paused',phase:null,tokens_used:null,
    status_display:'一時停止（保存時点）',phase_display:null,budget_display:'保存時点 4,906 / 100,000 tokens',elapsed_display:'1h02m'})
  assert.equal(snapshot.capabilities.resume,true);assert.equal(snapshot.capabilities.pause,false)
  assert.equal(snapshot.observedAt,source.observed_at)
  const active=read('paused');delete active.goal.current_status;active.goal.native.status='active';active.goal.native.elapsed_ms=65000
  f.set(active);const next=(await (await get()).json()).snapshot
  assert.equal(next.goal.current_status.status,'Active');assert.equal(next.goal.current_status.status_display,'進行中（保存時点）')
  assert.equal(next.goal.current_status.elapsed_display,'1m05s')
})

test('a08: 保存statusは開いた文字列。budget_limitedや未知値はPaused表示でpause/resumeを出さない',async t=>{
  const source=read('paused');delete source.goal.current_status
  source.goal.native.status='budget_limited';source.capabilities.pause=true;source.capabilities.resume=true
  const f=fixture(source),get=await http(t,f),{snapshot}=await (await get()).json()
  assert.equal(snapshot.availability,'available');assert.deepEqual(f.reports,[])
  assert.equal(snapshot.goal.native.status,'budget_limited')
  assert.equal(snapshot.goal.current_status.status,'Paused');assert.equal(snapshot.goal.current_status.status_display,'予算上限（保存時点）')
  assert.equal(snapshot.capabilities.pause,false);assert.equal(snapshot.capabilities.resume,false)
  const unknown=structuredClone(source);unknown.goal.native.status='infra_paused';f.set(unknown)
  const next=(await (await get()).json()).snapshot
  assert.equal(next.availability,'available');assert.equal(next.goal.current_status.status_display,'infra_paused（保存時点）')
  assert.equal(next.capabilities.resume,false)
  for(const name of ['constructor','toString','__proto__']){const inherited=structuredClone(source);inherited.goal.native.status=name;f.set(inherited)
    const s=(await (await get()).json()).snapshot
    assert.equal(s.goal.current_status.status_display,`${name}（保存時点）`);assert.equal(s.capabilities.resume,false);assert.equal(s.capabilities.pause,false)}
  const bad=structuredClone(source);bad.goal.native.status='';f.set(bad)
  assert.equal((await (await get()).json()).snapshot.availability,'unavailable')
})
