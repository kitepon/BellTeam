import assert from 'node:assert/strict'
import test from 'node:test'
import { DeliveryJob } from '../src/delivery-job.mjs'

const bot = { id: 'bot-synthetic', session: 'slot-synthetic' }
const make = (options = {}) => new DeliveryJob({ id: 'job-1', bot, info: { context: 'direct' }, startedAt: '2026-10-23T00:00:00.000Z', ...options })
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail }); promise.catch(() => {}); return { promise, resolve, reject } }
const run = { session_id: 'slot-synthetic', launch_id: 'a'.repeat(32), boundary: { kind: 'run', run_id: 'r1' } }
const accepted = () => {
  const job = make()
  job.receipt = { mode: 'agent_dispatch', event_cursor: 1 }
  job.execution = { binding: { target: run }, issued: new Set(['send']) }
  return job
}

test('停止要求は結論ではない。止まらなかったjobは操作の終わりで解放され、未受理だけを残す指定もできる', async () => {
  const operation = deferred()
  const unsent = make(), sent = accepted()
  for (const job of [unsent, sent]) job.requestStop(operation.promise)
  assert.throws(() => unsent.assertNotStopped(), { code: 'BOT_STOPPED' })
  unsent.release({ acceptedOnly: true }); sent.release({ acceptedOnly: true })
  assert.equal(unsent.stopRequested, true)
  assert.equal(sent.stopRequested, false)
  unsent.release()
  assert.equal(unsent.stopRequested, false)
  assert.equal(unsent.stopped, false)
})

test('受理済みの送信は、同じrunの確認済み中断だけで止まったと決める', async () => {
  const job = accepted()
  const other = { ...run, boundary: { kind: 'run', run_id: 'r0' } }
  assert.equal(await job.applyStopResult({ targets: [{ interruption: 'interrupted', session_preserved: 'confirmed', run: other }] }), false)
  assert.equal(job.stopped, false)
  assert.equal(await job.applyStopResult({ targets: [{ interruption: 'interrupted', session_preserved: 'confirmed', run }] }), true)
  assert.equal(job.stopped, true)
  assert.equal(job.controller.signal.aborted, true)
})

test('節目は進行中の停止操作を待ち、受理済みで停止未確認なら続け、未受理の停止失敗は失敗のまま返す', async () => {
  const stopping = deferred()
  const job = accepted()
  job.stopping = () => stopping.promise
  job.requestStop(stopping.promise)
  const checkpoint = job.checkpoint()
  let settled = false
  checkpoint.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)
  stopping.reject(Object.assign(new Error('停止を確認できませんでした。'), { code: 'BOT_STOP_UNCONFIRMED' }))
  await checkpoint
  assert.equal(job.stopRequested, false)

  const unsent = make()
  const failed = deferred()
  unsent.stopping = () => null
  unsent.requestStop(failed.promise)
  failed.reject(Object.assign(new Error('停止を確認できませんでした。'), { code: 'BOT_STOP_UNCONFIRMED' }))
  await assert.rejects(unsent.checkpoint(), { code: 'BOT_STOP_UNCONFIRMED' })
})

test('失敗の最終エラーは停止の結論から決め、未送信の実行登録だけをnot_sentで閉じる', async () => {
  const finished = []
  const job = make()
  job.execution = { issued: new Set(), binding: { target: run }, finish: async value => { finished.push(value) } }
  const stopped = deferred()
  job.requestStop(stopped.promise)
  stopped.resolve({})
  job.stopped = true
  const error = await job.failure(new Error('synthetic send failure'))
  assert.equal(error.code, 'BOT_STOPPED')
  assert.deepEqual(finished, [{ kind: 'not_sent' }])

  const paused = make()
  paused.execution = { issued: new Set(['send']), binding: { target: run }, finish: async () => { throw new Error('never') } }
  const kept = await paused.failure(Object.assign(new Error('AIを止めています。'), { code: 'AI_GLOBAL_PAUSED' }))
  assert.equal(kept.code, 'AI_GLOBAL_PAUSED')
  assert.equal(paused.stopped, true)
  assert.equal(paused.executionFinishUnconfirmed, false)

  const sent = accepted()
  const same = new Error('synthetic read failure')
  assert.equal(await sent.failure(same), same)
  assert.equal(sent.stopped, false)
})

test('一覧の項目は配送の事実だけを見せ、停止の内部状態を含めない', () => {
  const job = make({ info: { context: 'room', contextId: 'room-1', groupId: 'g1' } })
  job.requestStop(Promise.resolve())
  assert.deepEqual(job.queueItem(), { id: 'job-1', botId: bot.id, botName: bot.id, status: 'running', startedAt: '2026-10-23T00:00:00.000Z', context: 'room', contextId: 'room-1', groupId: 'g1' })
})
