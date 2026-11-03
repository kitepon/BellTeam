import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BellTeamMessenger } from '../src/messenger.mjs'

async function fixture(t, transport) {
  const root = await mkdtemp(join(tmpdir(), 'conversation-user-accepted-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return new BellTeamMessenger({ bots: new Map([['bot-a', { id: 'bot-a', name: 'A' }]]),
    transport, logPath: join(root, 'direct.jsonl') })
}

test('user.turn exposes acceptance synchronously and keeps the final answer save separate', async t => {
  const admitted = Promise.withResolvers(), ended = Promise.withResolvers(), started = Promise.withResolvers()
  const messenger = await fixture(t, { turn() {
    started.resolve(); ended.promise.accepted = admitted.promise; return ended.promise
  } })
  const completion = messenger.userTurn({ target: 'bot-a', message: 'Question' })
  assert.equal(typeof completion.accepted?.then, 'function')
  let terminal = false
  completion.then(() => { terminal = true })
  await started.promise
  admitted.resolve({ delivery: 'running' })
  const accepted = await completion.accepted
  assert.equal(terminal, false)
  assert.equal(accepted.from, 'user')
  assert.equal((await messenger.store.records()).length, 1)
  ended.resolve('Final answer')
  const result = await completion
  assert.equal(result.reply, 'Final answer')
  assert.equal((await messenger.store.records()).at(-1).message, 'Final answer')
  assert.equal(result.delivery_id, accepted.delivery_id)
})

test('preparation and native admission failures reject accepted without inventing success', async t => {
  const denied = new Error('native admission denied')
  const messenger = await fixture(t, { turn() {
    const turn = Promise.reject(denied)
    turn.accepted = Promise.reject(denied)
    return turn
  } })
  const missing = messenger.userTurn({ target: 'missing', message: 'Question' })
  await assert.rejects(missing.accepted, /BOT_NOT_FOUND/u)
  await assert.rejects(missing, /BOT_NOT_FOUND/u)
  const failed = messenger.userTurn({ target: 'bot-a', message: 'Question' })
  await assert.rejects(failed.accepted, error => error === denied)
  await assert.rejects(failed, error => error === denied)
})

test('accepted does not mask a later save failure or transfer answer claims to another turn', async t => {
  const admitted = Promise.withResolvers(), ended = Promise.withResolvers()
  const messenger = await fixture(t, { turn() { ended.promise.accepted = admitted.promise; return ended.promise } })
  const saved = Promise.withResolvers()
  const original = messenger.finishUserTurn.bind(messenger)
  messenger.finishUserTurn = async (...args) => { await saved.promise; return original(...args) }
  const completion = messenger.userTurn({ target: 'bot-a', message: 'Question' })
  admitted.resolve({ delivery: 'steered' })
  const accepted = await completion.accepted
  assert.equal(accepted.delivery, 'steered')
  ended.resolve('Final')
  const failure = new Error('save denied')
  saved.reject(failure)
  await assert.rejects(completion, error => error === failure)
  assert.equal((await messenger.store.records()).length, 1)
  assert.equal(messenger.claimedReplyIds.size, 0)
})
