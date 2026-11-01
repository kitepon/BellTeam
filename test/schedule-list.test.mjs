import assert from 'node:assert/strict'
import test from 'node:test'
import { createScheduleEditor, scheduleRequest, scheduleFormValues } from '../web/schedule-editor.js'
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a;reject=b });return {promise,resolve,reject} }
class Element {
  value = ''; disabled = false; hidden = false; listeners = {}; children = []; innerHTML = ''; textContent = ''
  addEventListener(name,fn) { this.listeners[name]=fn }
  replaceChildren(...rows) { this.children=rows }
  querySelector(selector) { this.buttons ??= {}; return this.buttons[selector] ??= new Element() }
  querySelectorAll() { return [] }
  reset() {}
  scrollIntoView() {}
}
function fixture(t, api) {
  const saved = globalThis.document
  globalThis.document = { createElement: () => new Element() }
  t.after(() => { globalThis.document = saved })
  const nodes = new Map()
  const get = selector => { if (!nodes.has(selector)) { const node=new Element();node.id=selector.slice(1);nodes.set(selector,node) }return nodes.get(selector) }
  const dialog = new Element()
  dialog.querySelector = get
  dialog.showModal=()=>{dialog.open=true}
  dialog.close=()=>{dialog.open=false;dialog.listeners.close()}
  const editor=createScheduleEditor(dialog,{api,getBot:id=>({displayName:id})})
  const defaults = {kind:'cron',action:'prompt',name:'',prompt:'hello',cron:'0 9 * * *'}
  for(const [id,value] of Object.entries(defaults))get('#schedule-'+id).value=value
  get('#schedule-form').querySelectorAll=()=>[...nodes.values()].filter(node=>node.id && Object.hasOwn(defaults,node.id.replace('schedule-','')))
  return {editor,dialog,get,list:get('#schedule-list'),form:get('#schedule-form'),error:get('#schedule-form-error'),save:()=>get('#schedule-form').listeners.submit({preventDefault(){}})}
}
test('list preserves recurring, unrun, disabled and rescheduled rows while hiding completed one-off rows',async t=>{
  const completed={kind:'once',enabled:false,lastRunAt:'2026-09-06T06:20:00Z',nextRunAt:null}
  const schedules=[{...completed,name:'実行済み'},{...completed,kind:'cron',name:'繰り返し'},{kind:'once',enabled:true,lastRunAt:null,name:'期限超過の未実行'},{kind:'once',enabled:false,lastRunAt:null,name:'停止中'},{...completed,enabled:true,nextRunAt:'2026-09-07T00:00:00Z',name:'再設定済み'}]
  const f=fixture(t,async()=>({schedules}));await f.editor.open({type:'bot',id:'a'})
  assert.equal(f.list.children.length,4)
  assert.deepEqual(f.list.children.map(row=>row.innerHTML.match(/<strong>(.*?)<\/strong>/u)[1]),['繰り返し','期限超過の未実行','停止中','再設定済み'])
  assert.equal(schedules.length,5)
})
test('completed one-off rows alone produce the empty list',async t=>{
 const f=fixture(t,async()=>({schedules:[{kind:'once',enabled:false,lastRunAt:'2026-09-06T06:20:00Z',nextRunAt:null}]}));await f.editor.open({type:'bot',id:'a'});assert.match(f.list.innerHTML,/予定はありません/)
})
test('save snapshots target and body; late accepted save cannot reset a reopened form',async t=>{
 const pending=deferred(),requests=[]
 const f=fixture(t,async(path,request)=>{requests.push({path,request});return request?pending.promise:{schedules:[]}})
 await f.editor.open({type:'bot',id:'a'})
 f.get('#schedule-prompt').value='old A'
 const save=f.save();await f.save()
 await f.editor.open({type:'bot',id:'b'})
 f.get('#schedule-prompt').value='new B'
 pending.resolve({});await save
 assert.equal(requests.filter(x=>x.request).length,1)
 assert.equal(requests.find(x=>x.request).path,'/api/bots/a/schedules')
 assert.equal(JSON.parse(requests.find(x=>x.request).request.body).prompt,'old A')
 assert.equal(f.get('#schedule-prompt').value,'new B')
 assert.equal(f.get('#schedule-submit').disabled,false)
})
test('accepted save and failed readback are distinct; editing during save keeps new input',async t=>{
 const pending=deferred();let reads=0,resets=0
 const f=fixture(t,async(path,request)=>{if(request)return pending.promise;if(++reads>1)throw Error('GET');return {schedules:[]}})
 await f.editor.open({type:'bot',id:'a'})
 f.form.reset=()=>{resets++}
 const saved=f.save()
 f.get('#schedule-prompt').value='next input';f.form.listeners.input()
 pending.resolve({});await saved
 assert.equal(resets,0)
 assert.equal(f.get('#schedule-prompt').value,'next input')
 assert.match(f.error.textContent,/保存しました。予定一覧を更新できません/)
})
test('late list cannot replace a newly opened target; run/delete use the row owner',async t=>{
 const old=deferred(),requests=[]
 const f=fixture(t,async(path,request)=>{requests.push({path,request});if(path==='/api/bots/a/schedules'&&!request)return old.promise;return {schedules:[{id:'row',name:'B row',kind:'cron',expression:'0 9 * * *'}]}})
 const opening=f.editor.open({type:'bot',id:'a'});await f.editor.open({type:'bot',id:'b'})
 const row=f.list.children[0]
 old.resolve({schedules:[{id:'old',name:'A row'}]});await opening
 assert.match(f.list.children[0].innerHTML,/B row/)
 // A detached old row still points at B even after another editor target is opened.
 await f.editor.open({type:'room',id:'c',memberIds:[]})
 const timer=globalThis.setTimeout;globalThis.setTimeout=()=>0;t.after(()=>{globalThis.setTimeout=timer})
 await row.querySelector('button.run').listeners.click()
 await row.querySelector('button.remove').listeners.click()
 assert.equal(requests.some(x=>x.path==='/api/bots/b/schedules/row/run'&&x.request.method==='POST'),true)
 assert.equal(requests.some(x=>x.path==='/api/bots/b/schedules/row'&&x.request.method==='DELETE'),true)
})
test('public form conversion retains cron, weekdays, one-off and room command/targets rules',()=>{
 const base={name:' name ',prompt:' prompt ',command:' cmd ',action:'command',kind:'weekly',weekdays:['1','5'],time:'09:30',targets:['bot-a']}
 assert.deepEqual(scheduleRequest(base,'room','Asia/Tokyo'),{name:'name',prompt:'prompt',enabled:true,targets:['bot-a'],kind:'cron',expression:'30 9 * * 1,5',timezone:'Asia/Tokyo'})
 assert.throws(()=>scheduleRequest({...base,weekdays:[]},'bot','UTC'),/WEEKDAY_REQUIRED/)
 assert.equal(scheduleRequest({...base,kind:'hourly',minute:'3'},'bot','UTC').expression,'3 * * * *')
 assert.equal(scheduleRequest({...base,kind:'daily'},'bot','UTC').expression,'30 9 * * *')
 assert.equal(scheduleRequest({...base,kind:'cron',cron:' 0 8 * * 1 '},'bot','UTC').expression,'0 8 * * 1')
 assert.equal(scheduleRequest({...base,kind:'once',once:'2026-11-01T00:00:00Z'},'bot','UTC').at,'2026-11-01T00:00:00.000Z')
 assert.deepEqual(scheduleFormValues({kind:'cron',expression:'30 9 * * 1,5'}),{type:'weekly',time:'09:30',weekdays:['1','5']})
 assert.deepEqual(scheduleFormValues({kind:'cron',expression:'0 * * * *'}),{type:'hourly',minute:'0'})
})

test('selecting another schedule during save keeps that editor after the first save completes',async t=>{
 const pending=deferred()
 const f=fixture(t,async(path,request)=>request?pending.promise:{schedules:[{id:'row-b',name:'B edit',prompt:'B prompt',kind:'cron',expression:'0 9 * * *'}]})
 await f.editor.open({type:'bot',id:'a'})
 const saved=f.save()
 f.list.children[0].querySelector('button.edit').listeners.click()
 pending.resolve({});await saved
 assert.equal(f.get('#schedule-name').value,'B edit')
 assert.equal(f.get('#schedule-prompt').value,'B prompt')
 assert.equal(f.get('#schedule-form-title').textContent,'予定を編集')
})
