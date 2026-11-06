import inspector from 'node:inspector'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { applyMcpDirectRoomBypass } from '../src/mcp-direct-room-adoption.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
const start=performance.now(), repo=new URL('../',import.meta.url)
const {createBellTeamServer}=await import(new URL('src/http-server.mjs',repo))
const {createConversationFacade}=await import(new URL('src/conversation-facade.mjs',repo))
const {callBellTeamTool}=await import(new URL('src/mcp-tools.mjs',repo))
const sdkURL=new URL(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'))
const {Server}=await import(sdkURL)
const {CallToolRequestSchema}=await import(new URL('../types.js',sdkURL))
let roomReads=0,paused=0
const failure=Object.assign(Error('rooms unavailable'),{code:'CONVERSATION_NOT_ACCEPTED'})
const facade=createConversationFacade({context:()=>({}),getController:()=>({request(){roomReads++;return Promise.reject(failure)}})})
const rooms=facade.rooms, registry=Object.assign(new Map([['bot-a',{id:'bot-a',name:'A'}],['bot-b',{id:'bot-b',name:'B'}]]),{async refresh(){}})
const secretMarker='DO_NOT_EXPAND_PRIVATE_SETTINGS'
const server=createBellTeamServer({bots:registry,rooms,roomMessenger:{},messenger:{},store:{},transport:{},memory:{},ownerProfile:{},authorize:async()=>true,secretRequests:{opaque:{secret:secretMarker}}})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const session=new inspector.Session();session.connect()
const post=(method,params={})=>new Promise((yes,no)=>session.post(method,params,(error,value)=>error?no(error):yes(value)))
session.on('Debugger.paused',()=>paused++)
const hash=value=>createHash('sha256').update(Function.prototype.toString.call(value)).digest('hex')
const sdkDescriptor=Object.getOwnPropertyDescriptor(Server.prototype,'setRequestHandler'),roomDescriptor=Object.getOwnPropertyDescriptor(rooms,'refresh')
const expected={setRequestHandler:hash(sdkDescriptor.value),refresh:hash(roomDescriptor.value)}
const actorScope=new AsyncLocalStorage(),actor=Object.freeze({kind:'bot',botId:'bot-a'}),old=Promise.withResolvers(),oldOwners=new Map([['old',old.promise]])
const calls=[],receipt={delivery:'running',delivery_id:'fixture-receipt'}
const tools={registry,from:'bot-a',rooms,deliverMessage:async input=>{assert.equal(actorScope.getStore(),actor);calls.push(input);return receipt}}
const newRequest=async(name,from='bot-a')=>{
 const sdk=new Server({name:'fixture',version:'1'},{capabilities:{tools:{}}})
 sdk.setRequestHandler(CallToolRequestSchema,request=>callBellTeamTool({...tools,from,name:request.params.name,arguments:request.params.arguments}))
 const handler=sdk._requestHandlers.get('tools/call')
 try{return await actorScope.run(actor,()=>handler({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:name==='get_self'?{}:{target:'bot-b',message:'new input'}}},{}))}
 finally{await sdk.close()}
}
try {
 assert.throws(()=>applyMcpDirectRoomBypass({rooms,Server,expected:{...expected,refresh:'0'.repeat(64)}}),{code:'MCP_ROOM_ADOPTION_MISMATCH'})
 assert.equal(Server.prototype.setRequestHandler,sdkDescriptor.value);assert.equal(rooms.refresh,roomDescriptor.value)
 await assert.rejects(newRequest('sendmessage'),{code:failure.code})
 const fn=await post('Runtime.evaluate',{expression:`(()=>{const found=process._getActiveHandles().filter(x=>x.constructor.name==='Server'&&x.listening&&x.address().port===${server.address().port});if(found.length!==1||typeof found[0].notify!=='function')throw Error('MCP_SERVER_REFERENCE_MISMATCH');return found[0].notify})()`})
 const refs=await post('Runtime.getProperties',{objectId:fn.result.objectId,ownProperties:true,generatePreview:false})
 const scopes=refs.internalProperties.find(x=>x.name==='[[Scopes]]').value
 const chain=await post('Runtime.getProperties',{objectId:scopes.objectId,ownProperties:true,generatePreview:false})
 const selected=chain.result.find(x=>x.value?.description==='Closure (createMessageEvents)')
 assert.ok(selected,JSON.stringify(chain.result.map(x=>x.value?.description)))
 const bindings=await post('Runtime.getProperties',{objectId:selected.value.objectId,ownProperties:true,generatePreview:false})
 assert.ok(!JSON.stringify(bindings).includes(secretMarker),'must not expand settings values')
 const roomRef=bindings.result.find(x=>x.name==='rooms')?.value
 assert.ok(roomRef?.objectId)
 const expression=`function(policy,sdkPath,expected){const require=process.getBuiltinModule('module').createRequire(process.cwd()+'/entry.js');const {Server}=require(sdkPath);return require(policy).applyMcpDirectRoomBypass({rooms:this,Server,expected})}`
 const adopted=await post('Runtime.callFunctionOn',{objectId:roomRef.objectId,functionDeclaration:expression,arguments:[{value:fileURLToPath(new URL('../src/mcp-direct-room-adoption.mjs',import.meta.url))},{value:fileURLToPath(sdkURL)},{value:expected}],returnByValue:true})
 assert.ok(!adopted.exceptionDetails,adopted.exceptionDetails?.text)
 assert.equal(adopted.result.value?.replaced,2)
 for(const name of ['sendmessage','send_user_message']) { const result=await newRequest(name); assert.equal(result.delivery,receipt.delivery);assert.equal(result.delivery_id,receipt.delivery_id) }
 await assert.rejects(newRequest('get_self'),{code:failure.code})
 await assert.rejects(newRequest('sendmessage','missing'),/BOT_NOT_FOUND: missing/u)
 assert.equal(calls.length,2);assert.equal(roomReads,2);assert.equal(facade.rooms,rooms);assert.equal(paused,0)
 assert.equal(oldOwners.get('old'),old.promise);let callbacks=0;old.promise.then(()=>callbacks++);old.resolve();await old.promise;assert.equal(callbacks,1)
 const result={node:process.version,referencePath:'fixed local HTTP Server.notify -> exact createMessageEvents closure -> rooms object reference',sameRooms:true,descriptorReplacements:2,newDirectInputs:calls.length,otherRoomRefusalPreserved:true,senderValidationPreserved:true,paused,heapQuery:0,sourceEdit:0,scopeWrites:0,secretValuesExpanded:0,rawInspectorFramesSaved:0,actorIdentityRetained:true,oldPromiseAndOwnerRetained:true,wrongFingerprintChanges:0,Host:0,caseMs:performance.now()-start,expected}
 console.log(JSON.stringify(result))
} finally {
 Object.defineProperty(Server.prototype,'setRequestHandler',sdkDescriptor);Object.defineProperty(rooms,'refresh',roomDescriptor)
 session.disconnect();await new Promise(resolve=>server.close(resolve))
}
