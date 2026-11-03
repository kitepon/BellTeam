import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { currentWork, workLabel, participantWork, roomWorkPreview } from '../web/current-work.js'
const examples=JSON.parse(await readFile(new URL('fixtures/web-current-work.json',import.meta.url)))
test('all six supplied finite currentWork states retain their distinct meanings',()=>{
 for(const value of Object.values(examples.currentWork))assert.deepEqual(currentWork(value),value)
 const w=examples.currentWork
 assert.equal(workLabel(w.workingCurrent),w.workingCurrent.summary)
 assert.equal(workLabel(w.workingMissing),'作業中・要約未設定')
 assert.equal(workLabel(w.workingStale),'作業中・要約期限切れ')
 assert.equal(workLabel(w.idle),'待機中')
 assert.equal(workLabel(w.unknownLastObservation),'仕事状況を未取得')
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
