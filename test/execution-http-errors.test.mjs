import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { createBellTeamServer } from '../src/http-server.mjs'
import { internalApi } from '../src/seat-mcp.mjs'

async function fixture(t, effect) {
  let calls = 0
  const error = Object.assign(new Error('internal native detail'), {
    schema: 'aiterm.execution-error.v1', code: 'EXECUTION_UNCONFIRMED', effect, follow_up: 'status_only',
  })
  const server = createBellTeamServer({ bots: new Map(), authorize: () => true, store: {}, transport: {},
    messenger: { async sendmessage() { calls++; throw error } } })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  return { port: server.address().port, calls: () => calls }
}

for (const effect of ['possible', 'not_started']) {
  test(`配送APIは${effect}の実行結果を隠さず、発行の不確実性と再送しない案内を返す`, async t => {
    const f = await fixture(t, effect)
    const response = await fetch(`http://127.0.0.1:${f.port}/api/deliveries/direct`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'bot-a', target: 'bot-b', message: 'fixture' }),
    })
    assert.equal(response.status, 500)
    const result = await response.json()
    assert.equal(result.error, 'EXECUTION_UNCONFIRMED')
    assert.equal(result.effect, effect)
    assert.equal(result.follow_up, 'status_only')
    assert.match(result.message, /再送/u)
    assert.match(result.message, effect === 'possible' ? /届いたか確認できません/u : /送信されていません/u)
    assert.equal(JSON.stringify(result).includes('internal native detail'), false)
    assert.equal(f.calls(), 1)
  })
}

test('Bot用MCPのAPI中継も結果不明と再送しない案内を保ち、HTTP要求を繰り返さない', async t => {
  const f = await fixture(t, 'possible')
  const api = internalApi(f.port)
  await assert.rejects(api.deliverMessage({ from: 'bot-a', target: 'bot-b', message: 'fixture' }), error => {
    assert.match(error.message, /EXECUTION_UNCONFIRMED/u)
    assert.match(error.message, /届いたか確認できません/u)
    assert.match(error.message, /再送/u)
    return true
  })
  assert.equal(f.calls(), 1)
})
