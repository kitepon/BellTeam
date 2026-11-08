import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createAccountsApi, readSeatAccount } from '../src/http-accounts-api.mjs'

function call(handler, method, path, body) {
  const request = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(body)]), { method, headers: { 'content-type': 'application/json' } })
  const response = { status: null, body: null, setHeader() {}, writeHead(status) { this.status = status }, end(chunk) { this.body = chunk ? JSON.parse(chunk) : null } }
  return Promise.resolve(handler(request, response, new URL(path, 'http://x'))).then(result => result === false ? false : response)
}

test('accounts routes return the engine values and map unsupported engines to 404', async () => {
  const seen = []
  const accounts = { list: async () => ({ harnesses: [], rules: [] }), setRule: async rule => { seen.push(rule); return { rules: [rule] } } }
  const owner = createAccountsApi({ accounts, internal: false })
  assert.equal(await call(owner, 'GET', '/api/other'), false)
  assert.deepEqual((await call(owner, 'GET', '/api/accounts')).body, { harnesses: [], rules: [] })
  const posted = await call(owner, 'POST', '/api/accounts/rules', JSON.stringify({ harness: 'claude', modelPrefix: 'claude-fable', slot: '2nd', extra: 1 }))
  assert.deepEqual([posted.status, seen], [200, [{ harness: 'claude', modelPrefix: 'claude-fable', slot: '2nd' }]])
  assert.deepEqual([(await call(owner, 'POST', '/api/accounts/rules', '{')).status, (await call(owner, 'POST', '/api/accounts/rules', '[]')).status], [400, 400])
  assert.equal((await call(owner, 'PUT', '/api/accounts')).status, 405)
  const seat = createAccountsApi({ accounts, internal: true })
  assert.deepEqual((await call(seat, 'POST', '/api/accounts/rules', '{}')).body, { error: 'ACCOUNT_RULE_OWNER_REQUIRED' })
  assert.equal((await call(createAccountsApi({ accounts: null }), 'GET', '/api/accounts')).status, 404)
  const old = { list: async () => { throw Object.assign(new Error('x'), { code: 'EXECUTION_REQUEST_INVALID' }) } }
  assert.equal((await call(createAccountsApi({ accounts: old }), 'GET', '/api/accounts')).status, 404)
  await assert.rejects(call(createAccountsApi({ accounts: { list: async () => { throw Object.assign(new Error('x'), { code: 'ACCOUNT_RULE_INVALID', status: 400 }) } } }), 'GET', '/api/accounts'), { code: 'ACCOUNT_RULE_INVALID' })
})

test('seat account is the slot, null without one, undefined when unsupported', () => {
  assert.deepEqual(readSeatAccount({ seatAccount: () => ({ harness: 'claude', slot: '2nd', preferredSlot: '1st' }) }, 'a'), { harness: 'claude', slot: '2nd', preferredSlot: '1st' })
  assert.equal(readSeatAccount({ seatAccount: () => null }, 'a'), null)
  assert.equal(readSeatAccount({}, 'a'), undefined)
  assert.equal(readSeatAccount({ seatAccount: () => { throw Object.assign(new Error('x'), { code: 'EXECUTION_REQUEST_INVALID' }) } }, 'a'), undefined)
})
