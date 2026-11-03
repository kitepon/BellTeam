import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { createMembersOwnerAuthorization } from '../src/members-owner-authorization.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'

test('Owner authorization is bound to parent identity, method, and request lifetime', () => {
  const authority = createMembersOwnerAuthorization(), request = { method: 'PUT' }
  const context = authority.captureHttp(request, '/api/user-rules')
  assert.equal(authority.authorizeOwner('rules.update', context.capturedAuthorization), true)
  for (const fake of [{}, { ownerWrite: true }, JSON.parse(JSON.stringify(context.capturedAuthorization)), null])
    assert.equal(authority.authorizeOwner('rules.update', fake), false)
  assert.equal(authority.authorizeOwner('owner.update', context.capturedAuthorization), false)
  authority.releaseHttp(request)
  assert.equal(authority.authorizeOwner('rules.update', context.capturedAuthorization), false)
  assert.equal(authority.captureHttp({ method: 'POST' }, '/mcp'), null)
})

test('real HTTP mints only after authentication, forwards context, and revokes on failure', async t => {
  const authority = createMembersOwnerAuthorization()
  let allow = false, calls = 0, captured
  const server = createBellTeamServer({ bots: new Map(), store: {}, transport: {}, membersAuthorization: authority,
    authorize: async () => allow, writeLog() {}, userRules: {
      async update(text, context) {
        calls++; captured = context.capturedAuthorization
        assert.equal(authority.authorizeOwner('rules.update', captured), true)
        assert.equal(authority.authorizeOwner('owner.update', captured), false)
        throw Object.assign(new Error('EXPECTED_REJECTION'), { code: 'EXPECTED_REJECTION', status: 409 })
      },
    } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/api/user-rules`
  const options = { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'rules', ownerWrite: true }) }
  assert.equal((await fetch(url, options)).status, 401); assert.equal(calls, 0)
  allow = true
  assert.equal((await fetch(url, options)).status, 409); assert.equal(calls, 1)
  assert.equal(authority.authorizeOwner('rules.update', captured), false)
})

test('internal HTTP never mints Owner authority', async t => {
  const authority = createMembersOwnerAuthorization()
  const server = createBellTeamServer({ bots: new Map(), store: {}, transport: {}, internal: true,
    membersAuthorization: authority, authorize: async () => true, writeLog() {}, userRules: {
      async update(text, context) { assert.equal(context, undefined); return text },
    } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/user-rules`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'rules' }),
  })
  assert.equal(response.status, 200)
})
