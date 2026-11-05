import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createBackgroundAgentSettings } from '../web/background-agent-settings.js'
import { editorDOM, deferred } from './helpers/editor-dom.mjs'
const wire=JSON.parse(await readFile(new URL('fixtures/background-agent-settings.json',import.meta.url)))
const models={codex:{efforts:['low','high'],models:[{id:wire.configured.selection.model,efforts:['high']}]},grok:{models:[{id:'no-effort',efforts:[]}]}}
function fixture(t,api){
 const {dialog:root}=editorDOM(t),node=name=>root.querySelector(`[data-background-${name}]`)
 const view=createBackgroundAgentSettings(root,api)
 return {view,node,choose(name,value){node(name).value=value;node(name).handlers.change()},submit:()=>root.handlers.submit({preventDefault(){}})}
}
function select(f){f.choose('harness','codex');f.choose('model',wire.configured.selection.model);f.choose('effort','high')}
test('unconfigured has no default; per-model candidates and exact CAS save are reread once',async t=>{
 let record=wire.unconfigured;const calls=[]
 const f=fixture(t,async(path,options)=>{
  calls.push({path,...options})
  if(path==='/api/models')return {models}
  if(options?.method){assert.deepEqual(JSON.parse(options.body),wire.patchInitial);record=wire.configured;return wire.patchSuccess}
  return {settings:[],backgroundAgent:record}
 })
 await f.view.open();assert.equal(f.node('harness').value,'');assert.equal(f.node('save').disabled,true)
 f.choose('harness','codex');f.choose('model',wire.configured.selection.model)
 assert.deepEqual(f.node('effort').children.map(option=>option.value),['','high'])
 f.choose('effort','low');assert.equal(f.node('save').disabled,true)
 f.choose('effort','high');await f.submit()
 assert.equal(calls.filter(call=>call.method==='PATCH').length,1)
 assert.equal(calls.filter(call=>call.path==='/api/settings').length,2)
 assert.match(f.node('status').textContent,/設定を保存しました/)
 assert.equal(f.view.dirty(),false)
 assert.match(f.node('saved').textContent,/high/)
})
test('empty efforts permits only the empty CLI default and harness change never patches',async t=>{
 const calls=[];const f=fixture(t,async(path,options)=>{calls.push(options);return path==='/api/models'?{models}:{backgroundAgent:wire.unconfigured}})
 await f.view.open();f.choose('harness','grok');f.choose('model','no-effort')
 assert.equal(f.node('effort').disabled,true);assert.equal(f.node('effort').value,'');assert.equal(f.node('save').disabled,false)
 f.choose('effort','high');assert.equal(f.node('save').disabled,true)
 assert(calls.every(call=>!call?.method))
})
test('old/malformed settings and missing saved candidates preserve read-only meaning',async t=>{
 let result={settings:[]};const f=fixture(t,async path=>path==='/api/models'?{models}:result)
 for(const value of [result,{backgroundAgent:{revision:null,selection:wire.configured.selection}},{backgroundAgent:{...wire.configured,extra:true}}]){
  result=value;await f.view.open();assert.equal(f.node('harness').disabled,true);assert.equal(f.node('save').disabled,true)
 }
 result={backgroundAgent:{...wire.configured,selection:{...wire.configured.selection,model:'removed-model'}}}
 await f.view.open();assert.equal(f.node('model').value,'removed-model');assert.equal(f.node('save').disabled,true)
 assert.match(f.node('error').textContent,/現在の候補にない/)
})
test('HTTP200 harness catalogue failure is visible and cannot save',async t=>{
 const f=fixture(t,async path=>path==='/api/models'?wire.modelCandidateFailureHTTP200:{backgroundAgent:wire.configured})
 await f.view.open();assert.equal(f.node('save').disabled,true);assert.match(f.node('error').textContent,/モデル候補を取得できません/)
 assert.equal(f.node('model').value,wire.configured.selection.model)
})
test('malformed model entries and rejected writes retain inputs without an automatic retry',async t=>{
 let catalog={codex:{models:[null]}},record=wire.configured,writes=0
 const f=fixture(t,async(path,options)=>{
  if(path==='/api/models')return {models:catalog}
  if(options?.method){writes++;throw Object.assign(Error('設定を保存していません。'),{status:writes===1?400:503})}
  return {backgroundAgent:record}
 })
 await f.view.open();assert.equal(f.node('save').disabled,true);assert.match(f.node('error').textContent,/モデル候補を取得できません/)
 catalog=models;record=wire.unconfigured;await f.view.open();select(f)
 await f.submit();assert.equal(writes,1);assert.equal(f.node('effort').value,'high')
 await f.submit();assert.equal(writes,2);assert.equal(f.node('model').value,wire.configured.selection.model)
 assert.equal(f.view.dirty(),true);assert.match(f.node('status').textContent,/保存していません/)
})
test('conflict rereads saved values and keeps the draft without retrying PATCH',async t=>{
 let record=wire.unconfigured,writes=0;const f=fixture(t,async(path,options)=>{
  if(path==='/api/models')return {models}
  if(options?.method){writes++;record={...wire.configured,selection:{harness:'grok',model:'no-effort',reasoningEffort:''}};throw Object.assign(Error(wire.revisionConflictHTTP409.message),{status:409})}
  return {backgroundAgent:record}
 })
 await f.view.open();select(f);await f.submit()
 assert.equal(writes,1);assert.equal(f.node('harness').value,'codex');assert.match(f.node('saved').textContent,/grok/)
 assert.match(f.node('status').textContent,/別の画面/);assert.equal(f.view.dirty(),true)
 await f.view.refresh();assert.equal(f.node('harness').value,'codex')
})
test('apply failure retains saved setting without claiming generated summary or repeating the write',async t=>{
 let record=wire.unconfigured,writes=0;const f=fixture(t,async(path,options)=>{
  if(path==='/api/models')return {models}
  if(options?.method){writes++;record=wire.configured;throw Object.assign(Error(wire.applyFailureHTTP500.message),{status:500})}
  return {backgroundAgent:record}
 })
 await f.view.open();select(f);await f.submit()
 assert.equal(writes,1);assert.match(f.node('saved').textContent,/high/);assert.match(f.node('status').textContent,/保存されています。要約の動作は未確認/)
})
test('save acknowledgement remains distinct from failed reread and later explicit read recovers',async t=>{
 let reads=0;const f=fixture(t,async(path,options)=>{
  if(path==='/api/models')return {models}
  if(options?.method)return wire.patchSuccess
  if(++reads===2)throw Error('read failed')
  return {backgroundAgent:reads===1?wire.unconfigured:wire.configured}
 })
 await f.view.open();select(f);await f.submit()
 assert.match(f.node('status').textContent,/設定を保存しました/);assert.match(f.node('error').textContent,/設定を取得できません/)
 assert.equal(f.node('save').disabled,true);await f.view.refresh();assert.equal(f.node('save').disabled,false)
})
test('reopening discards old save/read completion and latest read preserves unsaved draft',async t=>{
 const pending=deferred();let record=wire.unconfigured,writes=0
 const f=fixture(t,async(path,options)=>{
  if(path==='/api/models')return {models}
  if(options?.method){writes++;return pending.promise}
  return {backgroundAgent:record}
 })
 await f.view.open();select(f);const old=f.submit();await f.submit();assert.equal(writes,1)
 f.view.close();record={...wire.configured,selection:{harness:'grok',model:'no-effort',reasoningEffort:''}}
 await f.view.open();pending.resolve(wire.patchSuccess);await old
 assert.equal(f.node('harness').value,'grok');assert.equal(f.view.busy(),false)
 select(f);await f.view.refresh();assert.equal(f.node('harness').value,'codex');assert.match(f.node('saved').textContent,/grok/)
})
