import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { currentWork, workLabel, participantWork, roomWorkPreview, renderCurrentWork } from '../web/current-work.js'
const examples=JSON.parse(await readFile(new URL('fixtures/web-current-work.json',import.meta.url)))
test('all six supplied finite currentWork states retain their distinct meanings',()=>{
 for(const value of Object.values(examples.currentWork))assert.deepEqual(currentWork(value),value)
 const w=examples.currentWork
 assert.equal(workLabel(w.workingCurrent),w.workingCurrent.summary)
 assert.equal(workLabel(w.workingMissing),'作業中・要約未取得')
 assert.equal(workLabel(w.workingStale),'作業中・要約期限切れ')
 assert.equal(workLabel(w.idle),'待機中')
 assert.equal(workLabel(w.unknownLastObservation),'仕事状況を未取得')
})
test('generated and legacy summaries retain their sources while unknown sources remain unknown',()=>{
 const legacy=examples.currentWork.workingCurrent
 const generated={...legacy,summary:'設定画面を更新しています。',source:'background_agent'}
 const stale={...generated,summary:null,summaryStatus:'stale'}
 assert.deepEqual(currentWork(generated),generated)
 assert.deepEqual(currentWork(stale),stale)
 assert.equal(currentWork(legacy).source,'self_reported')
 for(const value of [{...generated,source:'future_agent'},{...stale,summary:'古い本文'},{...generated,summary:'猫'.repeat(161)},{...generated,state:'idle'},{...generated,summary:'指示\n本文'},{...generated,summary:' '+generated.summary}])assert.equal(currentWork(value).state,'unknown')
 assert.equal(currentWork({...generated,summary:'猫'.repeat(160)}).summary.length,160)
 const summary={},body={}
 const root={querySelector:selector=>selector==='summary'?summary:body}
 const bots=[{id:'a',name:'生成',currentWork:generated},{id:'b',name:'旧自己申告',currentWork:legacy}]
 const room={memberIds:['a','b'],currentWork:{scope:'participants',members:bots.map(bot=>({botId:bot.id,currentWork:bot.currentWork}))}}
 renderCurrentWork(root,'bot',bots[0],bots)
 assert.match(summary.textContent,/設定画面を更新しています/)
 assert.match(body.innerHTML,/<dt>要約の生成元<\/dt><dd>自動生成<\/dd>/)
 assert.doesNotMatch(body.innerHTML,/本人が記載した要約/)
 renderCurrentWork(root,'room',room,bots)
 assert.match(body.innerHTML,/<dd>自動生成<\/dd>/)
 assert.match(body.innerHTML,/<dd>本人記載<\/dd>/)
 assert.match(body.innerHTML,/参加者それぞれ/)
 renderCurrentWork(root,'bot',{...bots[0],currentWork:stale},bots)
 assert.match(body.innerHTML,/要約期限切れ/)
 assert.doesNotMatch(body.innerHTML,/設定画面を更新しています/)
 renderCurrentWork(root,'bot',{...bots[0],currentWork:{...generated,source:'future_agent'}},bots)
 assert.match(body.innerHTML,/仕事状況を未取得/)
 assert.doesNotMatch(body.innerHTML,/自動生成|本人記載|設定画面を更新しています/)
})
test('missing, inconsistent and malicious fields fail closed without recent or goal fallback',()=>{
 const w=examples.currentWork.workingCurrent
 for(const value of [undefined,null,{}, {...w,state:'idle'},{...w,source:null},{...w,summaryUpdatedAt:null},{...w,summary:'hidden\ntext'},{...w,summary:' '+w.summary},{...w,summary:'a'.repeat(161)},{...w,revision:'private'},{...w,observedAt:'invalid'}])assert.equal(currentWork(value).state,'unknown')
 assert.equal(currentWork({...w,summary:'猫'.repeat(160)}).summary.length,160)
})
test('Room uses only its participant projection, lists max two named summaries and never infers room work',()=>{
 const bots=['a','b','c','d'].map(id=>({id,name:id,currentWork:examples.currentWork.workingCurrent}))
 const room={name:'room',memberIds:['a','b','c'],currentWork:{scope:'participants',members:['a','b','c','d'].map(botId=>({botId,currentWork:examples.currentWork.workingCurrent}))}}
 assert.equal(participantWork(room,bots).length,3)
 assert.equal((roomWorkPreview(room,bots).match(/work-preview-line/g)||[]).length,2)
 assert.match(roomWorkPreview(room,bots),/参加者の現在の仕事/)
 assert.match(roomWorkPreview(room,bots),/ほか1人/)
 assert.doesNotMatch(roomWorkPreview(room,bots),/d:/)
 assert.match(roomWorkPreview({...room,currentWork:undefined},bots),/参加者の仕事要約を未取得/)
 const duplicate={...room,currentWork:{scope:'participants',members:[{botId:'a',currentWork:examples.currentWork.workingCurrent},{botId:'a',currentWork:examples.currentWork.workingCurrent}]}}
 assert.equal(participantWork(duplicate,bots)[0].work.state,'unknown')
})
