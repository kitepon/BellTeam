import assert from 'node:assert/strict'
import net from 'node:net'
import {syncBuiltinESMExports} from 'node:module'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {createContainerUpdateClient,createUpdateClients} from '../src/container-update-client.mjs'
async function fixture(t,handler,allowed=['/run/bellteam-updater/update.sock']){
 const root=await mkdtemp(join(tmpdir(),'host-update-client-')),path=join(root,'socket')
 const frames=[],connections=new Set(),paths=[]
 const server=net.createServer(socket=>{
  connections.add(socket);socket.on('close',()=>connections.delete(socket))
  let raw='';socket.on('data',chunk=>{raw+=chunk;if(raw.includes('\n')){const value=JSON.parse(raw);frames.push(value);handler(socket,value)}})
 })
 await new Promise(resolve=>server.listen(path,resolve))
 const connect=net.createConnection
 t.mock.method(net,'createConnection',options=>{assert.ok(allowed.includes(options.path));paths.push(options.path);return connect({path})})
 syncBuiltinESMExports()
 t.after(async()=>{for(const socket of connections)socket.destroy();await new Promise(resolve=>server.close(resolve));t.mock.restoreAll();syncBuiltinESMExports();await rm(root,{recursive:true,force:true})})
 return {client:createContainerUpdateClient(),frames,paths}
}
test('dedicated mount routes container separately; legacy shares a client and ambiguous start never falls back',async t=>{
 const fs=(await import('node:fs/promises')).default
 let mounted=false
 t.mock.method(fs,'lstat',async path=>{
  assert.equal(path,'/run/bellteam-container-updater')
  if(!mounted)throw Object.assign(Error(),{code:'ENOENT'})
  return {isDirectory:()=>true,isSymbolicLink:()=>false}
 })
 syncBuiltinESMExports()
 const legacy=await createUpdateClients();assert.equal(legacy.container,legacy.module)
 mounted=true
 const {frames,paths}=await fixture(t,(socket,frame)=>{
  if(frame.operation==='start')socket.destroy()
  else socket.end(JSON.stringify({ok:true,value:frame.params})+'\n')
 },['/run/bellteam-updater/update.sock','/run/bellteam-container-updater/update.sock'])
 const clients=await createUpdateClients();assert.notEqual(clients.container,clients.module)
 await clients.container.catalog('container');await clients.module.catalog('memory')
 await assert.rejects(clients.container.start({requestId:'a',planId:'b',confirmContainerRestart:true}),{code:'UNREADABLE',outcome:'not_accepted'})
 assert.deepEqual(paths,['/run/bellteam-container-updater/update.sock','/run/bellteam-updater/update.sock','/run/bellteam-container-updater/update.sock'])
 assert.deepEqual(frames.map(f=>f.operation),['catalog','catalog','start'])
 t.mock.method(fs,'lstat',async()=>{throw Object.assign(Error(),{code:'EACCES'})});syncBuiltinESMExports()
 await assert.rejects(createUpdateClients(),{code:'EACCES'})
})
test('checkCatalog sends the closed empty-params frame and returns the Host publication record',async t=>{
 const record={status:'failed',checkedAt:'2026-11-08T00:00:00Z',error:'HOST_UPDATE_PUBLICATION_UNCONFIRMED'}
 const {client,frames}=await fixture(t,socket=>socket.end(JSON.stringify({ok:true,value:record})+'\n'))
 assert.deepEqual(await client.checkCatalog(),record)
 assert.deepEqual(frames,[{operation:'checkCatalog',params:{}}])
})
test('fixed Unix client carries the common requestId and does not resend after ambiguous admission',async t=>{
 const {client,frames}=await fixture(t,(socket,frame)=>{
  if(frame.operation==='start')socket.destroy()
  else socket.end(JSON.stringify({ok:true,value:{requestId:frame.params.requestId,admission:'unknown'}})+'\n')
 })
 const requestId='a0dd350b-abda-4d12-b08b-3172105e2a71'
 await assert.rejects(client.start({requestId,planId:'b0dd350b-abda-4d12-b08b-3172105e2a71',confirmContainerRestart:true}),{code:'UNREADABLE',outcome:'not_accepted'})
 assert.equal((await client.operation(requestId)).requestId,requestId)
 assert.deepEqual(frames.map(frame=>frame.operation),['start','get'])
})
test('finite frames, closed error fields and unavailable capability',async t=>{
 const {client,frames}=await fixture(t,(socket,frame)=>{
  if(frame.operation==='capabilities')socket.end('invalid\n')
  else socket.end(JSON.stringify({ok:false,error:{code:'HOST_UPDATE_REQUEST_CONFLICT',status:409,outcome:'not_accepted'}})+'\n')
 })
 assert.deepEqual(await client.capabilities(),{supported:false,reason:'HOST_UPDATE_UNAVAILABLE',currentRequestId:null,previousRequestId:null})
 await assert.rejects(client.plan({planId:'x',catalogSha256:'y',versionId:'z'}),{status:409,outcome:'not_accepted'})
 await assert.rejects(client.start({value:'x'.repeat(65536)}),{code:'HOST_UPDATE_MESSAGE_LIMIT',outcome:'not_accepted'})
 assert.equal(frames.length,2)
})
test('module installation uses the same UUID lookup and explicitly requests no container restart',async t=>{
 const {client,frames}=await fixture(t,(socket,frame)=>socket.end(JSON.stringify({ok:true,value:frame.params})+'\n'))
 const plan={planId:'b0dd350b-abda-4d12-b08b-3172105e2a71',catalogSha256:'a'.repeat(64),componentId:'diagnostics',versionId:'b'.repeat(64)}
 assert.deepEqual(await client.planModuleInstall(plan),plan)
 const requestId='a0dd350b-abda-4d12-b08b-3172105e2a71'
 assert.equal((await client.startModuleInstall({requestId,planId:plan.planId})).confirmContainerRestart,false)
 await client.operation(requestId)
 assert.deepEqual(frames.map(frame=>frame.operation),['plan','start','get'])
 assert.equal(frames[2].params.requestId,requestId)
})
test('module installation remains unsupported on an old Host without the explicit protocol',async t=>{
 let protocol
 const {client}=await fixture(t,socket=>socket.end(JSON.stringify({ok:true,value:{supported:true,...(protocol===undefined?{}:{moduleInstallProtocol:protocol})}})+'\n'))
 assert.equal((await client.moduleInstallCapabilities()).supported,false)
 protocol=1;assert.deepEqual(await client.moduleInstallCapabilities(),{supported:true,reason:null})
 protocol=2;assert.equal((await client.moduleInstallCapabilities()).supported,false)
})

test('bundled module capability is separate from container capability and bound to the install protocol, not the body source',async t=>{
 const source='a'.repeat(40)
 let value={supported:false,reason:'HOST_CONTAINER_UPDATE_UNSUPPORTED',moduleInstallProtocol:1,moduleInstallSupported:true,moduleInstallerSource:source}
 const {client}=await fixture(t,socket=>socket.end(JSON.stringify({ok:true,value})+'\n'))
 assert.equal((await client.capabilities()).supported,false)
 assert.deepEqual(await client.moduleInstallCapabilities(),{supported:true,reason:null})
 value={...value,moduleInstallerSource:'b'.repeat(40)}
 assert.deepEqual(await client.moduleInstallCapabilities(),{supported:true,reason:null})
 value={...value,moduleInstallProtocol:2}
 assert.deepEqual((await client.moduleInstallCapabilities()).supported,false)
})

test('module capability acquisition preserves transport failures without replay and reads no local source',async t=>{
 let mode='transport'
 const {client}=await fixture(t,socket=>{
  if(mode==='transport')socket.destroy()
  else socket.end(JSON.stringify({ok:true,value:{moduleInstallProtocol:1,moduleInstallSupported:true,moduleInstallerSource:'a'.repeat(40)}})+'\n')
 })
 await assert.rejects(client.moduleInstallCapabilities(),{code:'UNREADABLE',path:'/run/bellteam-updater/update.sock',reason:'CONNECTION_CLOSED',status:503,outcome:'not_accepted'})
 mode='valid';assert.deepEqual(await client.moduleInstallCapabilities(),{supported:true,reason:null})
})
test('connect refused with EAGAIN (full backlog) connects again without replay, then reads the reply',async t=>{
 const {client,frames,paths}=await fixture(t,(socket,frame)=>socket.end(JSON.stringify({ok:true,value:{requestId:frame.params.requestId,phase:'completed'}})+'\n'))
 const refuse=()=>{const socket=new net.Socket();process.nextTick(()=>socket.emit('error',Object.assign(Error('connect EAGAIN'),{code:'EAGAIN'})));return socket}
 net.createConnection.mock.mockImplementationOnce(refuse,0);net.createConnection.mock.mockImplementationOnce(refuse,1)
 const requestId='c0dd350b-abda-4d12-b08b-3172105e2a71'
 assert.deepEqual(await client.operation(requestId),{requestId,phase:'completed'})
 assert.deepEqual(frames.map(frame=>frame.operation),['get'])
 assert.equal(paths.length,1);assert.equal(net.createConnection.mock.callCount(),3)
})
test('EAGAIN after the deadline and other connect errors stay typed UNREADABLE',async t=>{
 const client=createContainerUpdateClient('/nonexistent/update.sock')
 await assert.rejects(client.operation('x'),{code:'UNREADABLE',reason:'ENOENT'})
 t.mock.method(net,'createConnection',()=>{const socket=new net.Socket();process.nextTick(()=>socket.emit('error',Object.assign(Error(),{code:'EAGAIN'})));return socket})
 syncBuiltinESMExports()
 const started=Date.now()
 await assert.rejects(createContainerUpdateClient().plan({}),{code:'UNREADABLE',reason:'EAGAIN'})
 assert.ok(Date.now()-started>=4900)
})
