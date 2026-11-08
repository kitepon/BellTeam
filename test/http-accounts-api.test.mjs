import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createAccountsApi, readSeatAccount } from '../src/http-accounts-api.mjs'

function call(handler, method, path, body) {
  const request = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(body)]), { method, headers: { 'content-type': 'application/json' } })
  const response = { status: null, body: null, setHeader() {}, writeHead(status) { this.status = status }, end(chunk) { this.body = chunk ? JSON.parse(chunk) : null } }
  return Promise.resolve(handler(request, response, new URL(path, 'http://x'))).then(result => result === false ? false : response)
}

test('accounts route returns the engine list and maps unsupported engines to 404; rules route is gone', async () => {
  const owner = createAccountsApi({ accounts: { list: async () => ({ harnesses: [], rules: [] }) } })
  assert.equal(await call(owner, 'GET', '/api/other'), false)
  assert.equal(await call(owner, 'POST', '/api/accounts/rules', '{}'), false)
  assert.deepEqual((await call(owner, 'GET', '/api/accounts')).body, { harnesses: [], rules: [] })
  assert.equal((await call(owner, 'PUT', '/api/accounts')).status, 405)
  assert.equal((await call(createAccountsApi({ accounts: null }), 'GET', '/api/accounts')).status, 404)
  const old = { list: async () => { throw Object.assign(new Error('x'), { code: 'EXECUTION_REQUEST_INVALID' }) } }
  assert.equal((await call(createAccountsApi({ accounts: old }), 'GET', '/api/accounts')).status, 404)
  await assert.rejects(call(createAccountsApi({ accounts: { list: async () => { throw Object.assign(new Error('x'), { code: 'EXECUTION_REQUEST_FAILED', status: 500 }) } } }), 'GET', '/api/accounts'), { code: 'EXECUTION_REQUEST_FAILED' })
})

test('seat account is the slot, null without one, undefined when unsupported', () => {
  assert.deepEqual(readSeatAccount({ seatAccount: () => ({ harness: 'claude', slot: '2nd', preferredSlot: '1st' }) }, 'a'), { harness: 'claude', slot: '2nd', preferredSlot: '1st' })
  assert.equal(readSeatAccount({ seatAccount: () => null }, 'a'), null)
  assert.equal(readSeatAccount({}, 'a'), undefined)
  assert.equal(readSeatAccount({ seatAccount: () => { throw Object.assign(new Error('x'), { code: 'EXECUTION_REQUEST_INVALID' }) } }, 'a'), undefined)
})
