import assert from 'node:assert/strict'
import test from 'node:test'
import { respondHttpError } from '../src/http-errors.mjs'

const run = async error => {
  const recorded = [], out = {}
  await respondHttpError({ url: '/api/other', method: 'POST' }, { writeHead(status) { out.status = status }, end(body) { out.body = JSON.parse(body) } },
    error, { record: async report => { recorded.push(report) } })
  return { out, recorded }
}

test('設計どおりの保留 BOT_UPDATE_HOLD は503を返すが、SERVER_HTTP_503として記録しない', async () => {
  const { out, recorded } = await run(Object.assign(new Error('BOT_UPDATE_HOLD'), { code: 'BOT_UPDATE_HOLD', status: 503 }))
  assert.equal(out.status, 503)
  assert.equal(out.body.error, 'BOT_UPDATE_HOLD')
  assert.deepEqual(recorded, [])
})

test('ほかの型付き503は従来どおり記録する', async () => {
  const { out, recorded } = await run(Object.assign(new Error('MODULE_EXCHANGE_BUSY'), { code: 'MODULE_EXCHANGE_BUSY', status: 503 }))
  assert.equal(out.status, 503)
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].code, 'SERVER_HTTP_503')
  assert.equal(JSON.parse(recorded[0].diagnostic_log).error_code, 'MODULE_EXCHANGE_BUSY')
})
