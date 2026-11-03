import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import { createNotificationsParentChannel } from '../src/notifications-ipc.mjs'
const fixture = new URL('./fixtures/notifications-runtime-child.mjs', import.meta.url).pathname
async function start(t, options = {}) {
  const child = spawn(process.execPath, [fixture, 'builtin', options.mode ?? ''], { env: {}, stdio: ['ignore','ignore','pipe','ipc'] })
  const ended = once(child, 'close')
  const channel = createNotificationsParentChannel(child, options)
  t.after(async () => { child.kill('SIGKILL'); await ended; channel.dispose() })
  await channel.control('initialize', {configuration:{enabled:false,relayUrl:''}})
  await channel.ready
  return {child, channel, ended}
}
test('closed admission, accepted result, diagnostic ACK and graceful OS close', async t => {
  const reports=[]
  const {channel,ended}=await start(t,{onDiagnostic:async report=>reports.push(report)})
  await assert.rejects(channel.request('status',{}),{outcome:'not_accepted'})
  await channel.control('resume')
  await channel.request('status',{diagnostic:true})
  assert.equal(reports.length,1)
  await channel.control('quiesce')
  await assert.rejects(channel.request('register',{token:'test'}),{outcome:'not_accepted'})
  await channel.control('exit')
  assert.deepEqual(await ended,[0,null])
})
test('oversized and excess requests are unsent; ACK then crash is unknown and never replayed', async t => {
  const {channel}=await start(t)
  await channel.control('resume')
  await assert.rejects(channel.request('register',{token:'x'.repeat(65536)}),{outcome:'not_accepted'})
  const pending=Array.from({length:64},()=>channel.request('status',{delay:100}))
  await assert.rejects(channel.request('status',{}),{code:'PUSH_IPC_BUSY',outcome:'not_accepted'})
  await Promise.all(pending)
  await assert.rejects(channel.request('status',{crash:true}),{outcome:'unknown'})
})
test('quiesce waits for accepted work, and resume cancels a stale quiesce before it can pause again', async t => {
  const {channel}=await start(t)
  await channel.control('resume')
  const work=channel.request('register',{token:'kept',delay:150})
  const quiesce=channel.control('quiesce',{},5000)
  const rejected=assert.rejects(quiesce,{code:'PUSH_QUIESCE_CANCELLED'})
  await channel.control('resume')
  await work
  await rejected
  assert.deepEqual(await channel.request('status',{}),{configured:false,environments:[]})
})
