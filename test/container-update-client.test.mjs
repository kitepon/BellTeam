import assert from 'node:assert/strict'
import net from 'node:net'
import {syncBuiltinESMExports} from 'node:module'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {createContainerUpdateClient} from '../src/container-update-client.mjs'
async function fixture(t,handler){
 const root=await mkdtemp(join(tmpdir(),'host-update-client-')),path=join(root,'socket')
 const frames=[],connections=new Set()
 const server=net.createServer(socket=>{
  connections.add(socket);socket.on('close',()=>connections.delete(socket))
  let raw='';socket.on('data',chunk=>{raw+=chunk;if(raw.includes('\n')){const value=JSON.parse(raw);frames.push(value);handler(socket,value)}})
 })
 await new Promise(resolve=>server.listen(path,resolve))
 const connect=net.createConnection
 t.mock.method(net,'createConnection',options=>{assert.deepEqual(options,{path:'/run/bellteam-updater/update.sock'});return connect({path})})
 syncBuiltinESMExports()
 t.after(async()=>{for(const socket of connections)socket.destroy();await new Promise(resolve=>server.close(resolve));t.mock.restoreAll();syncBuiltinESMExports();await rm(root,{recursive:true,force:true})})
 return {client:createContainerUpdateClient(),frames}
}
test('fixed Unix client carries the common requestId and does not resend after ambiguous admission',async t=>{
 const {client,frames}=await fixture(t,(socket,frame)=>{
  if(frame.operation==='start')socket.destroy()
  else socket.end(JSON.stringify({ok:true,value:{requestId:frame.params.requestId,admission:'unknown'}})+'\n')
 })
 const requestId='a0dd350b-abda-4d12-b08b-3172105e2a71'
 await assert.rejects(client.start({requestId,planId:'b0dd350b-abda-4d12-b08b-3172105e2a71',confirmContainerRestart:true}),{outcome:'unknown'})
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

test('bundled module capability is separate from container capability and bound to the running source',async t=>{
 const fs=(await import('node:fs/promises')).default
 const source='a'.repeat(40)
 t.mock.method(fs,'readFile',async path=>{assert.equal(path,'/app/distribution.json');return JSON.stringify({sourceCommit:source})})
 syncBuiltinESMExports()
 let value={supported:false,reason:'HOST_CONTAINER_UPDATE_UNSUPPORTED',moduleInstallProtocol:1,moduleInstallSupported:true,moduleInstallerSource:source}
 const {client}=await fixture(t,socket=>socket.end(JSON.stringify({ok:true,value})+'\n'))
 assert.equal((await client.capabilities()).supported,false)
 assert.deepEqual(await client.moduleInstallCapabilities(),{supported:true,reason:null})
 value={...value,moduleInstallerSource:'b'.repeat(40)}
 assert.deepEqual(await client.moduleInstallCapabilities(),{supported:false,reason:'HOST_MODULE_SOURCE_CHANGED'})
})
