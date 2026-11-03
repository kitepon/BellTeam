import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareNotificationsRelease, validateNotificationsReleaseManifest } from '../src/notifications-release.mjs'
import { validateGatewayReleaseManifest } from '../src/web-gateway-release.mjs'
const fixture=()=>({schema:'bellteam.notifications.artifact.v1',component:'notifications',sourceCommit:'a'.repeat(40),
 entry:'payload/src/notifications-entry.mjs',runtime:{os:process.platform,arch:({x64:'amd64',arm64:'arm64'})[process.arch],nodeMajor:26,parentProtocol:1,stateSchema:1},
 files:['payload/src/notifications-entry.mjs','payload/package.json','payload/package-lock.json'].map(path=>({path,bytes:1,sha256:'b'.repeat(64)}))})
test('notification inventory needs no Web assets, and cannot be read as Web schema',()=>{
 const value=fixture();assert.equal(validateNotificationsReleaseManifest(value),value)
 assert.throws(()=>validateGatewayReleaseManifest(value))
 for(const mutate of [v=>delete v.runtime.stateSchema,v=>v.runtime.stateSchema=2,v=>v.runtime.foreign=true,
  v=>v.component='web-gateway',v=>v.entry='payload/src/http-gateway-entry.mjs',v=>v.files.pop()]){
  const value=fixture();mutate(value);assert.throws(()=>validateNotificationsReleaseManifest(value))
 }
})
test('notification reader rejects paths and cancellation without touching a store',async()=>{
 await assert.rejects(prepareNotificationsRelease('/tmp/archive'))
 const signal=AbortSignal.abort();await assert.rejects(prepareNotificationsRelease('a'.repeat(64),{signal}),{name:'AbortError'})
})
