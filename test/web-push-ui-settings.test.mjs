import test from 'node:test'
import assert from 'node:assert/strict'
import { createWebPushSettings, pushEnvironment, validPushStatus } from '../web/web-push.js'
import { Element, deferred } from './helpers/editor-dom.mjs'
const keyBytes=new Uint8Array(65).fill(1);keyBytes[0]=4
const key=Buffer.from(keyBytes).toString('base64url')
const status={enabled:true,configured:true,publicKey:key,error:null}
function fixture(options={}) {
 const root=new Element(),node=name=>root.querySelector(`[data-web-push-${name}]`)
 const state={installed:false,sub:null,saved:false,permissions:0,subscriptions:0,unsubscribes:0,workerRegistrations:0,unregisterFails:false,browserFails:false,registrationResponseLost:false,apiCalls:[],...options}
 const makeSub=()=>({endpoint:'https://fcm.googleapis.com/fcm/send/private-fixture-endpoint',expirationTime:null,options:{applicationServerKey:keyBytes.buffer},
  toJSON(){return{keys:{p256dh:key,auth:Buffer.alloc(16,2).toString('base64url')}}},
  async unsubscribe(){state.unsubscribes++;if(state.browserFails)throw Error(this.endpoint);state.sub=null;return true}})
 const registration={scope:'https://example.com/',active:{scriptURL:'https://example.com/sw.js'},pushManager:{async getSubscription(){return state.sub},async subscribe(value){assert.equal(value.userVisibleOnly,true);assert.deepEqual(value.applicationServerKey,keyBytes);state.sub=makeSub();state.subscriptions++;return state.sub}}}
 const browser={location:{origin:'https://example.com'},isSecureContext:true,PushManager:class{},Notification:{permission:'default',async requestPermission(){state.permissions++;this.permission=state.permissionReply??'granted';return this.permission}},navigator:{userAgent:'fixture',serviceWorker:{async getRegistration(){return state.installed?registration:undefined},async register(path,value){assert.equal(path,'/sw.js');assert.deepEqual(value,{scope:'/',type:'module',updateViaCache:'none'});state.installed=true;state.workerRegistrations++;return registration},ready:Promise.resolve(registration)}}}
 const api=async(path,value)=>{
  const body=value?.body?JSON.parse(value.body):null;state.apiCalls.push({path,body})
  if(options.api)return options.api(path,value)
  if(path==='/api/web-push/status'&&!body){if(state.unavailable)throw Error('unavailable');return state.status??status}
  if(path==='/api/web-push/status')return{registered:state.saved}
  if(path==='/api/web-push/subscriptions'){state.saved=true;if(state.registrationResponseLost)throw Error(body.subscription.endpoint);return{registered:true}}
  if(path==='/api/web-push/unregister'){if(state.unregisterFails)throw Error(body.endpoint);state.saved=false;return{registered:false}}
  throw Error('unexpected request')
 }
 if(state.installed&&options.existing)state.sub=makeSub()
 const view=createWebPushSettings(root,api,browser)
 return{root,node,state,browser,view,registration,click:async name=>node(name).handlers.click(),text:()=>[...root.nodes.values()].map(n=>n.textContent??'').join('\n')}
}
test('opening and foreground refresh never request permission, install SW, subscribe or save',async()=>{
 const f=fixture();await f.view.open();await f.view.refresh()
 assert.equal(f.node('enable').disabled,false);assert.equal(f.node('enable').textContent,'このブラウザーで受け取る')
 assert.equal(f.state.permissions,0);assert.equal(f.state.workerRegistrations,0);assert.equal(f.state.subscriptions,0)
 assert(f.state.apiCalls.every(c=>!c.body))
})
test('explicit preparation keeps user consent in a later click; lost save response is read once without repost',async()=>{
 const f=fixture({registrationResponseLost:true});await f.view.open()
 await f.click('enable');assert.equal(f.state.workerRegistrations,1);assert.equal(f.state.permissions,0)
 await Promise.all([f.click('enable'),f.click('enable')])
 assert.equal(f.state.permissions,1);assert.equal(f.state.subscriptions,1)
 assert.equal(f.state.apiCalls.filter(c=>c.path.endsWith('/subscriptions')).length,1)
 const request=f.state.apiCalls.find(c=>c.path.endsWith('/subscriptions')).body
 assert.deepEqual(Object.keys(request),['subscription','applicationServerKey']);assert.equal(Object.hasOwn(request,'origin'),false)
 assert.match(f.text(),/照会で確認/);assert.match(f.text(),/このブラウザーに通知が届きます/)
 assert.equal(f.node('enable').disabled,true);assert.doesNotMatch(f.text(),/private-fixture-endpoint/)
})
test('missing backend, denial, insecure and iOS Home Screen requirements remain distinct and cannot subscribe',async()=>{
 for(const mode of ['unavailable','denied','insecure','ios']){
  const f=fixture({unavailable:mode==='unavailable'})
  if(mode==='denied')f.browser.Notification.permission='denied'
  if(mode==='insecure')f.browser.isSecureContext=false
  if(mode==='ios')f.browser.navigator.userAgent='iPad'
  await f.view.open();assert.equal(f.node('enable').disabled,true)
  await f.click('enable');assert.equal(f.state.permissions,0);assert.equal(f.state.workerRegistrations,0)
  if(mode==='ios')assert.match(f.text(),/ホーム画面/)
  if(mode==='insecure')assert.match(f.text(),/HTTPS/)
  if(mode==='unavailable')assert.match(f.text(),/通知の設定を読めませんでした/)
 }
 const f=fixture({installed:true,permissionReply:'denied'});await f.view.open();await f.click('enable')
 assert.equal(f.state.permissions,1);assert.equal(f.state.subscriptions,0)
})
test('server removal failure still unsubscribes browser; retry touches only unfinished server part',async()=>{
 const f=fixture({installed:true,existing:true,saved:true,unregisterFails:true});await f.view.open()
 await f.click('remove');assert.equal(f.state.unsubscribes,1);assert.equal(f.node('enable').disabled,true)
 assert.match(f.text(),/サーバー側の解除は未確認/);assert.match(f.text(),/ブラウザー側は解除済み/)
 f.view.close();await f.view.open();f.state.unregisterFails=false;await f.click('remove')
 assert.equal(f.state.unsubscribes,1);assert.equal(f.state.saved,false)
 assert.match(f.text(),/もう通知を受け取りません/);assert.doesNotMatch(f.text(),/private-fixture-endpoint/)
})
test('browser removal failure preserves confirmed server removal and never reissues its mutation on retry',async()=>{
 const f=fixture({installed:true,existing:true,saved:true,browserFails:true});await f.view.open();await f.click('remove')
 assert.match(f.text(),/サーバー側は解除済み/);assert.match(f.text(),/ブラウザー側の解除は未確認/)
 f.state.browserFails=false;await f.click('remove')
 assert.equal(f.state.apiCalls.filter(c=>c.path.endsWith('/unregister')).length,1)
 assert.equal(f.state.unsubscribes,2);assert.match(f.text(),/もう通知を受け取りません/)
})
test('key mismatch and provider apply error disable registration without discarding the existing subscription',async()=>{
 const f=fixture({installed:true,existing:true});f.state.sub.options.applicationServerKey=new Uint8Array(65).buffer
 await f.view.open();assert.equal(f.node('enable').disabled,true);assert.equal(f.node('remove').disabled,false)
 assert.match(f.text(),/通知の鍵が変わりました/);assert.equal(f.state.unsubscribes,0)
 const g=fixture({status:{...status,error:{code:'WEB_PUSH_KEYS_INVALID',message:'safe'}}});await g.view.open();assert.equal(g.node('enable').disabled,true)
 assert(validPushStatus(status));assert.equal(validPushStatus({...status,publicKey:'bad'}),false)
})
test('an old status read cannot enable a reopened settings view',async()=>{
 const pending=deferred();let count=0
 const f=fixture({api:async()=>++count===1?pending.promise:{...status,enabled:false}})
 const first=f.view.open();f.view.close();await f.view.open();pending.resolve(status);await first
 assert.equal(f.node('enable').disabled,true);assert.match(f.text(),/まだできていません/)
})

test('supplier statuses retain disabled/error distinction; invalid keys are never treated as ready',async()=>{
 const {readFile}=await import('node:fs/promises')
 const values=JSON.parse(await readFile(new URL('fixtures/web-push-public.json',import.meta.url),'utf8'))
 for(const value of Object.values(values.status))assert(validPushStatus(value))
 const f=fixture({status:values.status.unavailable});await f.view.open()
 assert.match(f.node('summary').textContent,/エラー/);assert.equal(f.node('enable').disabled,true)
})

test('Owner authentication refusal is distinct from browser permission and never enables subscription',async()=>{
 const f=fixture({api:async()=>{throw Object.assign(Error('private'),{status:403})}});await f.view.open()
 assert.match(f.node('summary').textContent,/オーナーの認証/);assert.equal(f.node('enable').disabled,true);assert.equal(f.state.permissions,0)
})
