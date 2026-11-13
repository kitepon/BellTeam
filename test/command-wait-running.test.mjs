import assert from 'node:assert/strict'
import test from 'node:test'
import { createExecutionFacade } from '../src/execution-facade.mjs'

const bot = { id: 'bot-a', project: '/synthetic' }

// a71 (current-work.md): a schedule never makes a Bot read working; a released body that still passes commandWait has it ignored.
test('facade: a command wait changes neither currentWork nor runningState', () => {
  const idle = { state: 'idle', summary: null, summaryStatus: 'missing', summaryUpdatedAt: null, observedAt: null, source: null }
  const controller = { dispatch() {}, close() {}, project: ({ method }) => method === 'transport.currentTurn' ? { state: 'idle', turnId: null } : idle }
  const { transport } = createExecutionFacade({ getController: () => controller, client: {}, membersAdmission: {}, requestStop() {},
    watchQueue: () => () => {}, commandWait: () => '2026-11-12T05:00:00.000Z' })
  assert.deepEqual(transport.currentWork(bot), idle)
  assert.equal(transport.runningState(bot.id), 'idle')
  assert.deepEqual(transport.currentTurn(bot.id), { state: 'idle', turnId: null })
})
