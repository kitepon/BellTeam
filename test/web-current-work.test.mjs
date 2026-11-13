import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { currentWork, participantWork, renderCurrentWork, ago } from '../web/current-work.js'
const examples=JSON.parse(await readFile(new URL('fixtures/web-current-work.json',import.meta.url)))
test('all six supplied finite currentWork states retain their distinct meanings',()=>{
 for(const value of Object.values(examples.currentWork))assert.deepEqual(currentWork(value),value)
 const w=examples.currentWork
})
test('generated and legacy summaries retain their sources while unknown sources remain unknown',()=>{
 const legacy=examples.currentWork.workingCurrent
 const generated={...legacy,summary:'設定画面を更新しています。',source:'background_agent'}
 const stale={...generated,summary:null,summaryStatus:'stale'}
 assert.deepEqual(currentWork(generated),generated)
 assert.deepEqual(currentWork(stale),stale)
 assert.equal(currentWork(legacy).source,'self_reported')
 for(const value of [{...generated,source:'future_agent'},{...stale,summary:'古い本文'},{...legacy,state:'idle'},{...generated,summary:'指示\n本文'},{...generated,summary:' '+generated.summary}])assert.equal(currentWork(value).state,'unknown')
 assert.equal(currentWork({...generated,summary:'猫'.repeat(500)}).summary.length,500)
 const summary={},body={}
 const root={querySelector:selector=>selector==='summary'?summary:body}
 const bots=[{id:'a',name:'生成',currentWork:generated},{id:'b',name:'旧自己申告',currentWork:legacy}]
 const room={memberIds:['a','b'],currentWork:{scope:'participants',members:bots.map(bot=>({botId:bot.id,currentWork:bot.currentWork}))}}
 renderCurrentWork(root,'bot',bots[0],bots)
 assert.equal(root.hidden,false)
 assert.match(summary.textContent,/^いまの仕事: 設定画面を更新しています。（/)
 assert.match(body.innerHTML,/最終更新 /)
 assert.doesNotMatch(body.innerHTML,/自動生成|本人記載|実行状態|<dt>/)
 renderCurrentWork(root,'room',room,bots)
 assert.equal(summary.textContent,'いまの仕事: 生成 ほか1人')
 assert.match(body.innerHTML,/<h3>旧自己申告<\/h3>/)
 // Stale, unknown or missing summaries show nothing (P4).
 for(const currentWork of [stale,{...generated,source:'future_agent'},undefined]){renderCurrentWork(root,'bot',{...bots[0],currentWork},bots);assert.equal(root.hidden,true)}
 renderCurrentWork(root,'bot',null,bots);assert.equal(root.hidden,true)
})
test('background summary freshness is independent from all three observed execution states',()=>{
 const generated={...examples.currentWork.workingCurrent,source:'background_agent'}
 for(const state of ['working','idle','unknown'])for(const summaryStatus of ['current','missing','stale']){
  const value={...generated,state,summaryStatus,summary:summaryStatus==='current'?generated.summary:null,summaryUpdatedAt:summaryStatus==='missing'?null:generated.summaryUpdatedAt,source:summaryStatus==='missing'?null:'background_agent'}
  assert.deepEqual(currentWork(value),value)
 }
 const unobserved={...generated,state:'unknown',observedAt:null}
 assert.deepEqual(currentWork(unobserved),unobserved)
 // A current summary is shown even while the execution state is unobserved.
 const summary={},root={hidden:true,querySelector:selector=>selector==='summary'?summary:{}}
 renderCurrentWork(root,'bot',{name:'非対応native',currentWork:unobserved},[])
 assert.equal(root.hidden,false)
 assert.match(summary.textContent,/共通APIの接続を確認しています/)
 for(const state of ['idle','unknown'])for(const summaryStatus of ['current','stale'])assert.equal(currentWork({...generated,state,summaryStatus,summary:summaryStatus==='current'?generated.summary:null,source:'self_reported'}).summaryStatus,'missing')
 assert.equal(currentWork({...generated,state:'idle',observedAt:null}).summaryStatus,'missing')
})
test('missing, inconsistent and malicious fields fail closed without recent or goal fallback',()=>{
 const w=examples.currentWork.workingCurrent
 for(const value of [undefined,null,{}, {...w,state:'idle'},{...w,source:null},{...w,summaryUpdatedAt:null},{...w,summary:'hidden\ntext'},{...w,summary:' '+w.summary},{...w,revision:'private'},{...w,observedAt:'invalid'}])assert.equal(currentWork(value).state,'unknown')
 assert.equal(currentWork({...w,summary:'猫'.repeat(500)}).summary.length,500)
})
test('Room uses only its participant projection and never infers room work',()=>{
 const bots=['a','b','c','d'].map(id=>({id,name:id,currentWork:examples.currentWork.workingCurrent}))
 const room={name:'room',memberIds:['a','b','c'],currentWork:{scope:'participants',members:['a','b','c','d'].map(botId=>({botId,currentWork:examples.currentWork.workingCurrent}))}}
 assert.equal(participantWork(room,bots).length,3)
 const duplicate={...room,currentWork:{scope:'participants',members:[{botId:'a',currentWork:examples.currentWork.workingCurrent},{botId:'a',currentWork:examples.currentWork.workingCurrent}]}}
 assert.equal(participantWork(duplicate,bots)[0].work.state,'unknown')
})
test('ago words',()=>{
 const now=Date.parse('2026-11-12T00:00:00Z')
 assert.equal(ago('2026-11-11T23:59:40Z',now),'たった今')
 assert.equal(ago('2026-11-11T23:55:00Z',now),'5分前')
 assert.equal(ago('2026-11-11T21:00:00Z',now),'3時間前')
 assert.equal(ago('2026-11-09T00:00:00Z',now),'3日前')
})
test('the optional reason key (a41) is tolerated on a working Bot and malformed reasons stay unknown',()=>{
 const working={...examples.currentWork.workingCurrent,reason:{kind:'background',detail:'node vite.js dev',since:'2026-11-13T00:00:00.000Z'}}
 assert.deepEqual(currentWork(working),working)
 assert.equal(currentWork({...working,reason:null}).state,'working')
 for(const reason of [{kind:'other',detail:null,since:null},{kind:'turn',detail:'a\nb',since:null},{kind:'turn',detail:null}])assert.equal(currentWork({...working,reason}).state,'unknown')
 const idle=Object.values(examples.currentWork).find(value=>value.state==='idle')
 assert.equal(currentWork({...idle,reason:{kind:'turn',detail:null,since:null}}).state,'unknown')
})
