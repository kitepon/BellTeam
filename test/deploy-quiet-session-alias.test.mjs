import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const source = process.env.QUIET_UNDER_TEST ? pathToFileURL(resolve(process.env.QUIET_UNDER_TEST))
  : new URL('../scripts/check-deploy-quiet.mjs', import.meta.url)
const { assessDeployQuiet, checkDeployQuiet, collectDeployTurns } = await import(source.href)
const first = { botId: 'bot-first', session: 'shared-session', project: '/fixture/first', candidates: [] }
const second = { botId: 'bot-second', session: 'shared-session', project: '/fixture/second', candidates: [] }

test('a shared session cannot establish idle for two different Bots in either order', () => {
  for (const seats of [[first, second], [second, first]]) {
    const result = assessDeployQuiet({ except: 'bot-self', items: [], seats,
      turns: new Map([['shared-session', { state: 'idle' }]]) })
    assert.equal(result.quiet, false)
    assert.deepEqual(result.unclassifiedBots, ['bot-first', 'bot-second'])
    assert.deepEqual(result.otherBotCliOrQueued, ['bot-first', 'bot-second'])
  }
})

test('the queue/process/turn pipeline refuses aliases even when one session is confirmed idle', async () => {
  for (const order of [[first, second], [second, first]]) {
    const calls = []
    const result = await checkDeployQuiet({ except: 'bot-self',
      fetchQueue: async () => { calls.push('queue'); return [] },
      readSeats: async () => { calls.push('seats'); return { seats: structuredClone(order), unknown: 0 } },
      readSeatTurns: seats => {
        calls.push('turns')
        return collectDeployTurns({ seatTurns: async () => null }, seats,
          { confirmIdle: async () => ({ state: 'idle' }) })
      },
    })
    assert.equal(result.quiet, false)
    assert.deepEqual(result.unclassifiedBots, ['bot-first', 'bot-second'])
    assert.deepEqual(calls, ['queue', 'seats', 'turns', 'seats', 'queue'])
  }
})

test('unique session idle/running/unknown and queue failures retain existing decisions', async () => {
  const seats = [first, { ...second, session: 'different-session' }]
  for (const [state, expected] of [['idle', true], ['running', false], ['unknown', false]]) {
    const result = await checkDeployQuiet({ except: 'bot-self', fetchQueue: async () => [],
      readSeats: async () => ({ seats: structuredClone(seats), unknown: 0 }),
      readSeatTurns: async () => new Map(seats.map(seat => [seat.session, { state }])),
    })
    assert.equal(result.quiet, expected)
  }
  const common = { except: 'bot-self', readSeats: async () => ({ seats: [], unknown: 0 }) }
  await assert.rejects(checkDeployQuiet({ ...common, fetchQueue: async () => null }), /DEPLOY_QUIET_QUEUE_INVALID/)
  const error = new Error('synthetic queue failure')
  await assert.rejects(checkDeployQuiet({ ...common, fetchQueue: async () => { throw error } }), value => value === error)
})
