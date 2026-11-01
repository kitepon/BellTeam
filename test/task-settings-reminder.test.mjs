import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
const root = resolve(process.env.MODEL_POLICY_SOURCE_ROOT || new URL('..', import.meta.url).pathname)
const { AitermTransport } = await import(pathToFileURL(join(root,'src/aiterm-transport.mjs')))
const { BellTeamMessenger, directEnvelope } = await import(pathToFileURL(join(root,'src/messenger.mjs')))
const globalInstructions = await import(pathToFileURL(join(root,'src/global-instructions.mjs')))
const reminder = text => text.split('\n\n<bellteam_task_settings>\n')[1]?.split('\n</bellteam_task_settings>')[0]
const receipt = mode => mode === 'agent_steer' ? {mode} : {mode,event_cursor:1,wait_process:{executable:'/node',args:[]}}
const clientFor = (calls,mode='agent_dispatch') => ({async call(name,args){
 calls.push({name,args})
 if(name==='pty_send')return{structuredContent:receipt(mode)}
 if(name==='pty_observe')return{}
 if(name==='pty_read')return{structuredContent:{schema:'aiterm.pty-read-result.v1',mode:'agent_transcript',text:'完了'}}
 throw Error('unexpected '+name)
}})

test('task settings: one canonical rule reaches all five CLI globals with owner and user rules intact',async t=>{
 const home=await mkdtemp(join(tmpdir(),'model-policy-home-'));t.after(()=>rm(home,{recursive:true,force:true}))
 for(const cli of ['claude','codex','grok','cursor','gemini'])await mkdir(join(home,'.'+cli))
 await globalInstructions.createGlobalInstructionsRefresher({home,ownerProfile:{get:async()=>({name:'Synthetic owner',links:[]})},userRules:{get:async()=>'Synthetic user rule'}})()
 const rule=await globalInstructions.taskSettingsReminder()
 for(const text of ['Sol最新版のHighを基本','Terra最新版のxhigh','極めて単純な作業を行う担当に限り','get_self','list_models','update_self','set_fast_mode(enabled=false)','次ターン','独立した工程'])assert.ok(rule.includes(text),text)
 for(const cli of ['claude','codex','grok','cursor','gemini']){
  const text=await readFile(join(home,'.'+cli,'AGENTS.md'),'utf8')
  assert.ok(text.includes(rule));assert.ok(text.includes('Synthetic owner'));assert.ok(text.includes('Synthetic user rule'))
 }
 const common=await readFile(join(root,'config/common-agents.md'),'utf8')
 assert.match(common,/現在の設定が適切なら書き戻さない/)
 assert.match(common,/Terra xhighで想定外の結果が出たら、調査へ入る前にSol High/)
 assert.doesNotMatch(common,/LunaのHigh|平常時はTerra|平常の仕事へ戻る時はTerra/)
 assert.match(common,/AIが不要な実行は従来どおりcommand予定/)
})

test('task settings: live sessions receive the reminder on dispatch and steering across all harnesses, setup stays unchanged',async()=>{
 for(const harness of ['codex','claude','grok','cursor'])for(const mode of ['agent_dispatch','agent_steer']){
  const calls=[],transport=new AitermTransport({client:clientFor(calls,mode)}),bot={id:'bot-a',session:'live-session',harness}
  await transport.dispatch(bot,'元の依頼',[])
  const sent=calls.find(c=>c.name==='pty_send').args.text
  assert.ok(sent.startsWith('元の依頼\n\n<bellteam_task_settings>'))
  assert.equal(reminder(sent),await globalInstructions.taskSettingsReminder())
  assert.equal(sent.split('<bellteam_task_settings>').length,2)
  assert.ok(!calls.some(c=>['agent_launch','agent_configure','pty_close'].includes(c.name)))
  await transport.dispatch(bot,'セットアップ確認',[],{setupTest:true})
  assert.equal(calls.filter(c=>c.name==='pty_send').at(-1).args.text,'セットアップ確認')
 }
})

test('task settings: execution bridge delivery carries the same rule without changing execution arguments',async()=>{
 const calls=[],transport=new AitermTransport({executionBridge:{}}),bot={id:'bot-a',session:'live-session',harness:'codex'}
 const job={executionWasPresent:true,execution:{invoke:async(name,args,options)=>{calls.push({name,args,options});return{structuredContent:receipt('agent_dispatch')}}}}
 await transport.dispatch(bot,'元のbridge依頼',[],{executionJob:job})
 assert.equal(calls.length,1);assert.equal(calls[0].name,'pty_send');assert.equal(calls[0].args.session_id,'live-session')
 assert.equal(reminder(calls[0].args.text),await globalInstructions.taskSettingsReminder())
 assert.ok(calls[0].args.text.startsWith('元のbridge依頼\n\n'))
 assert.equal(calls[0].args.require_agent,true)
})

test('task settings: messenger stores the original statement while only AI input gains the review rule',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'model-policy-message-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const calls=[],transport=new AitermTransport({client:clientFor(calls),waitProcess:async()=>({outcome:'done'}),interimInterval:60000})
 const rows=new Map([['bot-a',{id:'bot-a',name:'Sender'}],['bot-b',{id:'bot-b',name:'Receiver',harness:'codex',session:'live-session'}]])
 const bots={refresh:async()=>{},has:id=>rows.has(id),get:id=>rows.get(id)}
 const messenger=new BellTeamMessenger({bots,transport,logPath:join(dir,'messages.jsonl')})
 const result=await messenger.sendmessage({from:'bot-a',target:'bot-b',message:'保存する元の発言'})
 assert.equal(result.delivery,'running');await transport.idle('bot-b')
 const events=(await readFile(join(dir,'messages.jsonl'),'utf8')).trim().split('\n').map(JSON.parse)
 const original=events.find(r=>r.message==='保存する元の発言')
 assert.ok(original);assert.ok(!JSON.stringify(original).includes('bellteam_task_settings'))
 const sent=calls.find(c=>c.name==='pty_send').args.text
 assert.ok(sent.startsWith(directEnvelope(rows.get('bot-a'),'保存する元の発言')))
 assert.equal(reminder(sent),await globalInstructions.taskSettingsReminder())
})
