import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import { createNotificationsParentChannel, waitNotificationsChildClose } from '../src/notifications-ipc.mjs'
const fixture = new URL('./fixtures/notifications-runtime-child.mjs', import.meta.url).pathname
async function start(t, options = {}) {
  const child = spawn(process.execPath, [fixture, 'builtin', options.mode ?? ''], { env: {}, stdio: ['ignore','ignore','pipe','ipc'] })
  const ended = waitNotificationsChildClose(child).then(({code,signal})=>[code,signal])
  const channel = createNotificationsParentChannel(child, options)
  t.after(async () => { child.kill('SIGKILL'); await ended; channel.dispose() })
  await channel.control('initialize', {configuration:{apns:{enabled:false,relayUrl:''},webPush:{enabled:false,subject:''}}})
  await channel.ready
  return {child, channel, ended}
}
test('additive APNs status keeps old fields and future receipt fields, validates read option shapes', async t => {
  const old = await start(t)
  await old.channel.control('resume')
  assert.deepEqual(await old.channel.request('status', { provider: 'apns' }), { configured: false, environments: [] })
  const { channel } = await start(t, { mode: 'extended-status' })
  await channel.control('resume')
  const attemptId = '11111111-2222-3333-4444-555555555555'
  const result = await channel.request('status', { provider: 'apns', attemptId, deviceOffset: 20 })
  assert.equal(result.configured, false)
  assert.deepEqual(result.updateAttempts, { future: [null, true, 1.5, 'kept'], items: [{ extraAttemptField: { devices: [{ extraDeviceField: 'kept' }] } }] })
  assert.deepEqual(result.requested, { attemptId, deviceOffset: 20 })
  for (const options of [{ attemptId: 'bad' }, { before: 'bad' }, { deviceOffset: -1 }, { deviceOffset: 1.2 }]) {
    await assert.rejects(channel.request('status', { provider: 'apns', ...options }), { code: 'PUSH_IPC_ARGUMENTS', outcome: 'not_accepted', status: 400 })
  }
})
test('closed admission, accepted result, diagnostic ACK and graceful OS close', async t => {
  const reports=[]
  const {channel,ended}=await start(t,{onDiagnostic:async report=>reports.push(report)})
  await assert.rejects(channel.request('status',{provider:'apns'}),{outcome:'not_accepted'})
  await channel.control('resume')
  await channel.request('status',{provider:'apns',diagnostic:true})
  assert.equal(reports.length,1)
  await channel.control('quiesce')
  await assert.rejects(channel.request('register',{provider:'apns',token:'test'}),{outcome:'not_accepted'})
  await channel.control('exit')
  assert.deepEqual(await ended,[0,null])
})
test('oversized and excess requests are unsent; ACK then crash is unknown and never replayed', async t => {
  const {channel}=await start(t)
  await channel.control('resume')
  await assert.rejects(channel.request('register',{provider:'apns',token:'x'.repeat(65536)}),{outcome:'not_accepted'})
  const pending=Array.from({length:64},()=>channel.request('status',{provider:'apns',delay:100}))
  await assert.rejects(channel.request('status',{provider:'apns'}),{code:'PUSH_IPC_BUSY',outcome:'not_accepted'})
  await Promise.all(pending)
  await assert.rejects(channel.request('status',{provider:'apns',crash:true}),{outcome:'unknown'})
})
test('quiesce waits for accepted work, and resume cancels a stale quiesce before it can pause again', async t => {
  const {channel}=await start(t)
  await channel.control('resume')
  const work=channel.request('register',{provider:'apns',token:'kept',delay:150})
  const quiesce=channel.control('quiesce',{},5000)
  const rejected=assert.rejects(quiesce,{code:'PUSH_QUIESCE_CANCELLED'})
  await channel.control('resume')
  await work
  await rejected
  assert.deepEqual(await channel.request('status',{provider:'apns'}),{configured:false,environments:[]})
})

test('parent disconnect drains an accepted operation before child exit',async t=>{
 const {channel,child,ended}=await start(t)
 await channel.control('resume')
 const work=channel.request('register',{provider:'apns',token:'still-saving',delay:120})
 const failed=assert.rejects(work,{outcome:'unknown'})
 // A later request establishes that the delayed operation has already been admitted.
 await channel.request('status',{provider:'apns'})
 const at=Date.now();child.disconnect();await failed
 assert.deepEqual(await ended,[0,null]);assert.ok(Date.now()-at>=75)
})
