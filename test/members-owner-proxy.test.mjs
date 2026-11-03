import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { createMembersOwnerProxy } from '../src/members-owner-proxy.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'

test('dedicated proxy reaches the parent and empty unknown grants never write', async t => {
  let writes = 0
  const server = createBellTeamServer({ internal: true, bots: new Map(), store: {}, transport: {},
    authorize: async () => true, writeLog() {}, userRules: { async update() { writes++ } } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const proxy = createMembersOwnerProxy({ port: server.address().port })
  await assert.rejects(proxy.updateUserRules('synthetic'), { code: 'MEMBERS_OWNER_UNAVAILABLE', status: 403 })
  assert.equal(writes, 0)
  const forged = await fetch(`http://127.0.0.1:${server.address().port}/internal/members-owner`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ownerWrite: true, actor: 'owner' }),
  })
  assert.equal(forged.status, 403); assert.equal(writes, 0)
})
